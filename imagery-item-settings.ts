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
const GUARDED_KEY = '__exb_imagery_item_where_guarded__'
const TAG = '[AddData][Imagery]'

interface ItemSettings {
  itemLayer: __esri.Layer
  rawWhere?: string
  reactiveUtils: typeof __esri.reactiveUtils
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
  title: layer?.title,
  url: layer?.url,
  children: Array.from((layer?.layers?.toArray?.() ?? layer?.layers ?? []) as any[]).map(describeTree)
})

const isTrivialWhere = (where: any): boolean => !where || String(where).replace(/\s/g, '') === '1=1'

/** `where` combined with the item's query, or `where` itself when it already contains it. */
function mergeWhere (itemWhere: string, where: any): string {
  if (isTrivialWhere(where)) return itemWhere
  if (String(where).includes(itemWhere)) return where
  return `(${itemWhere}) AND (${where})`
}

async function loadItemSettings (dsJson: IMDataSourceJson): Promise<ItemSettings> {
  const [Layer, PortalItem, reactiveUtils] = await loadArcGISJSAPIModules(['esri/layers/Layer', 'esri/portal/PortalItem', 'esri/core/reactiveUtils'])
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
  return { itemLayer, rawWhere, reactiveUtils }
}

/**
 * The map's layer view re-applies the data source's query to the layer (setDefinitionExpressionToLayer),
 * which replaces the item's query with "1=1". Put the item's query back whenever that happens.
 */
function guardWhere (settings: ItemSettings, layer: any, itemWhere: string): void {
  if (!layer || layer[GUARDED_KEY] === itemWhere) return
  layer[GUARDED_KEY] = itemWhere
  settings.reactiveUtils.watch(() => layer.definitionExpression, (value: string) => {
    const next = mergeWhere(itemWhere, value)
    if (next === value) return
    console.log(TAG, 'restored item query after reset', { title: layer.title, was: value, now: next })
    layer.definitionExpression = next
    const rule = layer.mosaicRule?.clone()
    if (rule && rule.where !== itemWhere) {
      rule.where = itemWhere
      layer.mosaicRule = rule
    }
  })
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
  // The item's query can sit in definitionExpression, the mosaic rule or the raw item data. Make sure
  // both the definition expression and the mosaic rule of the target carry it.
  const where = getItemWhere(source, rawWhere)
  if (where) {
    try {
      target.definitionExpression = where
      const rule = target.mosaicRule?.clone() ?? target.defaultMosaicRule?.clone() ?? source.defaultMosaicRule?.clone()
      if (rule) {
        rule.where = where
        target.mosaicRule = rule
      }
      applied.push('where')
    } catch (e) {
      console.warn(TAG, 'could not apply where', e)
    }
  }
  return applied
}

export function getItemWhere (source: any, rawWhere?: string): string | undefined {
  return [source?.definitionExpression, source?.mosaicRule?.where, rawWhere].find(w => !isTrivialWhere(w))
}

const normalizeTitle = (t?: string): string => (t || '').trim().toLowerCase()

/** Pick the item layer that corresponds to `target`: same title first, then same position. */
function findSource (sources: any[], target: any, index: number, total: number, extraNames: string[] = []): any {
  if (sources.length === 1) return sources[0]
  const names = [target?.title, ...extraNames].map(normalizeTitle).filter(Boolean)
  const byTitle = sources.find(s => names.includes(normalizeTitle(s.title)))
  if (byTitle) return byTitle
  if (sources.length === total) return sources[index]
  return undefined
}

/** Copy the item's image service settings onto the image service layers found in `target`. */
function applyToLayer (settings: ItemSettings, target: any, label: string): void {
  const sources = collectImageryLayers(settings.itemLayer)
  const targets = collectImageryLayers(target)
  console.log(TAG, `${label}: layer structure`, JSON.stringify(describeTree(target)))
  targets.forEach((t, index) => {
    const source = findSource(sources, t, index, targets.length)
    if (!source) {
      console.warn(TAG, `${label}: no matching item layer for`, t.title, t.url)
      return
    }
    const rawWhere = sources.length === 1 ? settings.rawWhere : undefined
    const applied = copySettings(source, t, rawWhere)
    const itemWhere = getItemWhere(source, rawWhere)
    if (itemWhere) guardWhere(settings, t, itemWhere)
    console.log(TAG, `${label}: applied item settings`, {
      title: t.title,
      matchedTitle: source.title,
      applied,
      mosaicWhere: t.mosaicRule?.where,
      definitionExpression: t.definitionExpression
    })
  })
  if (targets.length === 0) console.warn(TAG, `${label}: no image service layer found to apply settings to`)
}

/** Apply the item settings to the single image layer owned by a child data source of the group. */
function applyToChildLayer (settings: ItemSettings, child: any, layer: any): void {
  const sources = collectImageryLayers(settings.itemLayer)
  const childJson = child.getDataSourceJson?.()
  const names = [child.getLabel?.(), childJson?.label, childJson?.sourceLabel, childJson?.name]
  let source = findSource(sources, layer, -1, -2, names)
  const layerIndex = Number(childJson?.layerId)
  if (!source && Number.isInteger(layerIndex)) source = sources[layerIndex]
  if (!source) {
    console.warn(TAG, 'child: no matching item layer for', names, layer?.url)
    return
  }
  const rawWhere = sources.length === 1 ? settings.rawWhere : undefined
  const applied = copySettings(source, layer, rawWhere)
  // The framework re-applies the data source's query to the layer (syncQueryParams), which would
  // wipe the item's query. Make the data source's own query include it.
  child.__itemWhere = getItemWhere(source, rawWhere)
  if (child.__itemWhere) guardWhere(settings, layer, child.__itemWhere)
  console.log(TAG, 'child layer: applied item settings', {
    child: child.id,
    title: layer?.title,
    matchedTitle: source.title,
    applied,
    mosaicWhere: layer?.mosaicRule?.where
  })
}

function patchChildDataSource (child: any, settingsPromise: Promise<ItemSettings>): void {
  if (!child || child[PATCHED_KEY] || child.type !== DataSourceTypes.ImageryLayer) return
  child[PATCHED_KEY] = true

  // Both are used by the framework to compute the where it writes into the layer.
  ;['getCurrentQueryParams', 'getRealQueryParams'].forEach(method => {
    const original = child[method]?.bind(child)
    if (!original) return
    child[method] = (...args: any[]) => {
      const query = original(...args)
      const itemWhere: string | undefined = child.__itemWhere
      if (!itemWhere || !query) return query
      const where = mergeWhere(itemWhere, query.where)
      return where === query.where ? query : { ...query, where }
    }
  })

  const originalCreate = child.createJSAPILayerByDataSource?.bind(child)
  if (originalCreate) {
    child.createJSAPILayerByDataSource = async (...args: any[]) => {
      const layer = await originalCreate(...args)
      try {
        if (layer) applyToChildLayer(await settingsPromise, child, layer)
      } catch (e) {
        console.warn(TAG, 'failed to apply item settings to child layer', child.id, e)
      }
      return layer
    }
  }
  settingsPromise.then(settings => {
    if (child.layer) applyToChildLayer(settings, child, child.layer)
  }).catch(e => console.warn(TAG, 'failed to apply item settings to child data source layer', child.id, e))
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

    // Child data sources (one per image layer) build their own map layers; patch them too.
    if (typeof anyDs.createChildDataSourceById === 'function') {
      const originalCreateChild = anyDs.createChildDataSourceById.bind(ds)
      anyDs.createChildDataSourceById = async (...args: any[]) => {
        const child = await originalCreateChild(...args)
        patchChildDataSource(child, settingsPromise)
        return child
      }
    }
    ;(anyDs.getChildDataSources?.() ?? []).forEach((child: any) => patchChildDataSource(child, settingsPromise))

    // Also update the data source's own layer, used for queries.
    if (anyDs.layer) {
      applyToLayer(await settingsPromise, anyDs.layer, 'data source layer')
    }
  } catch (e) {
    console.warn(TAG, 'failed to apply item settings', ds?.id, e)
  }
}
