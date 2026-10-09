import { analyzeGenericXml } from "./genericXmlImporter.js";

export const IMPORTER_TYPES = Object.freeze({
  GENERIC_XML: "generic_xml"
});

export function analyzeFeedXml(xml, {
  feedType = IMPORTER_TYPES.GENERIC_XML,
  maxProperties,
  maxPhotos
} = {}) {
  if (feedType !== IMPORTER_TYPES.GENERIC_XML) {
    const error = new Error("Tipo de feed no soportado.");
    error.code = "UNSUPPORTED_FEED_TYPE";
    throw error;
  }

  return {
    feedType,
    properties: analyzeGenericXml(xml, { maxProperties, maxPhotos })
  };
}
