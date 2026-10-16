import { loadArcGISJSAPIModules, type DataSource, DataSourceTypes, type IMDataSourceJson } from 'jimu-core'

/**
 * Image service layer items can store layer settings (mosaic rule incl. its `where`, definition
 * expression, rendering rule, band ids...). The framework builds the layers of an item-based
 * data source from the service URL only, so those settings are dropped and the whole service is
 * shown. Webmaps do not have this problem because the JS API applies the item/layer definition.
 *
 * Such an item can arrive as an IMAGERY_LAYER data source or as a GROUP_LAYER data source whose
 * child is the image service. This loads the same portal item through the JS API (which parses the
 * item data) and copies the relevant settings onto every image service layer the map receives.
 */
const IMAGERY_SETTINGS = [
  'definitionExpression',
  'mosaicRule',
  'renderingRule',
  'bandIds',
  'interpolation',
  'compressionQuality',
  'compressionTolerance',
  'format',
  'noData',
  'noDataInterpretation',
  'pixelFilter',
  'multidimensionalDefinition',
  'opacity',
  'blendMode',
  'minScale',
  'maxScale'
]

const PATCHED_KEY = '__exb_imagery_item_settings_patched__'
const TAG = '[AddData][Imagery]'

interface ItemSettings {
  itemLayer: __esri.Layer
  rawWhere?: string
}

const isImageryLayer = (layer: any): boolean => layer?.type === 'imagery'

/** The layer itself if it is an image service, otherwise every image service layer nested in it. */
function collectImageryLayers (layer: any, out: any[] = []): any[] {
  if (!layer) return out
  if (isImageryLayer(layer)) {
    out.push(layer)
    return out
  }
  const children = layer.layers?.toArray?.() ?? layer.layers ?? []
  Array.from(children as any[]).forEach(child => collectImageryLayers(child, out))
  return out
}

const describeTree = (layer: any): any => ({
  type: layer?.type,
  url: layer?.url,
  children: Array.from((layer?.layers?.toArray?.() ?? layer?.layers ?? []) as any[]).map(describeTree)
})

const normalizeUrl = (url?: string): string => (url || '').toLowerCase().replace(/\/+$/, '')
const isTrivialWhere = (where: any): boolean => !where || String(where).replace(/\s/g, '') === '1=1'

async function loadItemSettings (dsJson: IMDataSourceJson): Promise<ItemSettings> {
  const [Layer, PortalItem] = await loadArcGISJSAPIModules(['esri/layers/Layer', 'esri/portal/PortalItem'])
  const portalItem = new PortalItem({ id: dsJson.itemId, portal: dsJson.portalUrl ? { url: dsJson.portalUrl } : undefined })
  const itemLayer: __esri.Layer = await Layer.fromPortalItem({ portalItem })
  await itemLayer.load()
  console.log(TAG, 'item layer structure', JSON.stringify(describeTree(itemLayer)))

  // The JS API may not parse the query out of the item. Read the raw item data as a fallback.
  let rawWhere: string | undefined
  try {
    const data = await portalItem.fetchData()
    console.log(TAG, 'raw item data', JSON.stringify(data))
    const candidates = [
      data?.mosaicRule?.where,
      data?.definitionExpression,
      data?.layerDefinition?.mosaicRule?.where,
      data?.layerDefinition?.definitionExpression,
      data?.layers?.[0]?.mosaicRule?.where,
      data?.layers?.[0]?.definitionExpression,
      data?.layers?.[0]?.layerDefinition?.mosaicRule?.where,
      data?.layers?.[0]?.layerDefinition?.definitionExpression
    ]
    rawWhere = candidates.find(c => typeof c === 'string' && !isTrivialWhere(c))
  } catch (e) {
    console.warn(TAG, 'could not read raw item data', e)
  }
  return { itemLayer, rawWhere }
}

function copySettings (source: __esri.ImageryLayer, target: __esri.ImageryLayer, rawWhere?: string): string[] {
  const applied: string[] = []
  IMAGERY_SETTINGS.forEach(key => {
    const value = (source as any)[key]
    if (value === undefined || value === null) return
    // Do not override with JS API defaults when the item did not specify anything.
    if (key === 'definitionExpression' && !value) return
    try {
      (target as any)[key] = value && typeof value.clone === 'function' ? value.clone() : value
      applied.push(key)
    } catch (e) {
      console.warn(`${TAG} could not apply "${key}"`, e)
    }
  })
  // Fallback: the item stores a query the JS API did not turn into a mosaic rule.
  if (rawWhere && isTrivialWhere((target.mosaicRule as any)?.where)) {
    try {
      target.definitionExpression = rawWhere
      const rule = target.mosaicRule ? target.mosaicRule.clone() : source.mosaicRule?.clone()
      if (rule) {
        rule.where = rawWhere
        target.mosaicRule = rule
      }
      applied.push('rawWhere')
    } catch (e) {
      console.warn(TAG, 'could not apply raw where', e)
    }
  }
  return applied
}

/** Copy the item's image service settings onto the image service layers found in `target`. */
function applyToLayer (settings: ItemSettings, target: any, label: string): void {
  const sources = collectImageryLayers(settings.itemLayer)
  const targets = collectImageryLayers(target)
  console.log(TAG, `${label}: layer structure`, JSON.stringify(describeTree(target)))
  targets.forEach((t, index) => {
    const source = sources.find(s => normalizeUrl(s.url) === normalizeUrl(t.url)) ??
      (sources.length === targets.length ? sources[index] : sources[0])
    if (!source) return
    const applied = copySettings(source, t, settings.rawWhere)
    console.log(TAG, `${label}: applied item settings`, {
      url: t.url,
      applied,
      mosaicWhere: t.mosaicRule?.where,
      definitionExpression: t.definitionExpression
    })
  })
  if (targets.length === 0) console.warn(TAG, `${label}: no image service layer found to apply settings to`)
}

export async function applyImageryItemSettings (ds: DataSource): Promise<void> {
  const dsJson = ds?.getDataSourceJson?.() as IMDataSourceJson
  console.log(TAG, 'data source check', { id: ds?.id, type: ds?.type, itemId: dsJson?.itemId, url: dsJson?.url, portalUrl: dsJson?.portalUrl })
  const supportedType = ds?.type === DataSourceTypes.ImageryLayer || ds?.type === DataSourceTypes.GroupLayer
  if (!supportedType || !dsJson?.itemId) return

  const anyDs = ds as any
  if (anyDs[PATCHED_KEY]) return
  anyDs[PATCHED_KEY] = true

  try {
    // Load the item once; every layer created for this data source reuses it.
    const settingsPromise = loadItemSettings(dsJson)

    // The map does not reuse ds.layer: it calls createJSAPILayerByDataSource, which builds a new
    // layer from the service URL and loses the item's mosaic rule. Apply the settings to that layer too.
    const originalCreate = anyDs.createJSAPILayerByDataSource?.bind(ds)
    if (originalCreate) {
      anyDs.createJSAPILayerByDataSource = async (...args: any[]) => {
        const layer = await originalCreate(...args)
        try {
          if (layer) {
            const settings = await settingsPromise
            // A group layer's children can still be loading; wait so they can be matched by url.
            await (layer as any).load?.()
            applyToLayer(settings, layer, 'map layer')
          }
        } catch (e) {
          console.warn(TAG, 'failed to apply item settings to map layer', ds.id, e)
        }
        return layer
      }
    }

    // Also update the data source's own layer, used for queries.
    if (anyDs.layer) {
      applyToLayer(await settingsPromise, anyDs.layer, 'data source layer')
    }
  } catch (e) {
    console.warn(TAG, 'failed to apply item settings', ds?.id, e)
  }
}
