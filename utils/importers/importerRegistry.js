import { analyzeGenericXml } from "./genericXmlImporter.js";
import { analyzeInmowebXml, buildInmowebSnapshot, isInmowebXml } from "../import/adapters/inmoweb.js";
import { buildSyncSnapshot } from "../import/syncSnapshot.js";

export const IMPORTER_TYPES = Object.freeze({
  GENERIC_XML: "generic_xml",
  INMOWEB: "inmoweb"
});

// Detection is opt-in. Existing HTTP flows retain their generic_xml default.
export function detectFeedType(xml) {
  return isInmowebXml(xml) ? IMPORTER_TYPES.INMOWEB : IMPORTER_TYPES.GENERIC_XML;
}

const adapters = new Map([
  [IMPORTER_TYPES.INMOWEB, { analyze: analyzeInmowebXml, snapshot: buildInmowebSnapshot }],
  [IMPORTER_TYPES.GENERIC_XML, { analyze: (xml, options) => ({
    feedType: IMPORTER_TYPES.GENERIC_XML, properties: analyzeGenericXml(xml, options)
  }), snapshot: buildSyncSnapshot }]
]);

function adapterFor(feedType) {
  const adapter = adapters.get(feedType);
  if (adapter) return adapter;
  throw Object.assign(new Error("Tipo de feed no soportado."), { code: "UNSUPPORTED_FEED_TYPE" });
}

export function buildFeedSnapshot(xml, { feedType = IMPORTER_TYPES.GENERIC_XML } = {}) {
  return adapterFor(feedType).snapshot(xml);
}

export function analyzeFeedXml(xml, {
  feedType = IMPORTER_TYPES.GENERIC_XML,
  maxProperties,
  maxPhotos
} = {}) {
  return adapterFor(feedType).analyze(xml, { maxProperties, maxPhotos });
}
