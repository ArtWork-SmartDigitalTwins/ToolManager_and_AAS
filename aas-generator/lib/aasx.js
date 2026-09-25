'use strict';

const zlib = require('zlib');
const { XMLParser } = require('fast-xml-parser');

// ---------------------------------------------------------------------
// ZIP (OPC) reader - EOCD + central directory, zlib for inflate.
// ---------------------------------------------------------------------

function findEOCD(buf) {
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error('Not a valid ZIP/.aasx package (no end-of-central-directory record)');
}

function openZip(buf) {
  const eocd = findEOCD(buf);
  const cdCount = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);

  const entries = new Map();
  let off = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    const sig = buf.readUInt32LE(off);
    if (sig !== 0x02014b50) throw new Error('Malformed central directory entry in package');
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const uncompSize = buf.readUInt32LE(off + 24);
    const fnLen = buf.readUInt16LE(off + 28);
    const exLen = buf.readUInt16LE(off + 30);
    const cmLen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf-8', off + 46, off + 46 + fnLen);
    if (!name.endsWith('/')) entries.set(name, { method, compSize, uncompSize, lho });
    off += 46 + fnLen + exLen + cmLen;
  }

  function bytesFor(name) {
    const e = entries.get(name);
    if (!e) return null;
    const fnLen = buf.readUInt16LE(e.lho + 26);
    const exLen = buf.readUInt16LE(e.lho + 28);
    const start = e.lho + 30 + fnLen + exLen;
    const comp = buf.subarray(start, start + e.compSize);
    if (e.method === 0) return Buffer.from(comp);
    if (e.method === 8) return zlib.inflateRawSync(comp);
    throw new Error('Unsupported compression method (' + e.method + ') in package');
  }

  function textFor(name) {
    const b = bytesFor(name);
    if (!b) return null;
    let t = b.toString('utf-8');
    if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
    return t;
  }

  return { names: Array.from(entries.keys()), bytesFor, textFor };
}

// ---------------------------------------------------------------------
// OPC relationship resolution: root .rels -> aasx-origin -> aas-spec
// ---------------------------------------------------------------------

function stripSlash(p) { return p.replace(/^\/+/, ''); }
function dirOf(p) { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); }
function baseOf(p) { const i = p.lastIndexOf('/'); return i < 0 ? p : p.slice(i + 1); }
function joinPath(dir, name) { return dir ? dir + '/' + name : name; }
function resolveTarget(sourcePart, target) {
  return target.charAt(0) === '/' ? stripSlash(target) : joinPath(dirOf(sourcePart), target);
}

const relsParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  isArray: (name) => name === 'Relationship'
});

function parseRelationships(xmlText) {
  const doc = relsParser.parse(xmlText);
  const rels = (doc.Relationships && doc.Relationships.Relationship) || [];
  return rels.map((r) => ({ type: r.Type || '', target: r.Target || '' }));
}

function resolveAasSpecParts(zip) {
  const rootRelsText = zip.textFor('_rels/.rels');
  if (!rootRelsText) throw new Error('Not a valid .aasx package (missing _rels/.rels)');
  const rootRels = parseRelationships(rootRelsText);
  const originRel = rootRels.find((r) => /aasx-origin$/i.test(r.type));

  let specPaths = [];
  if (originRel) {
    const originPart = resolveTarget('', originRel.target);
    const originRelsPath = joinPath(dirOf(originPart), '_rels/' + baseOf(originPart) + '.rels');
    const originRelsText = zip.textFor(originRelsPath);
    if (originRelsText) {
      const originRels = parseRelationships(originRelsText);
      specPaths = originRels
        .filter((r) => /aas-spec(-split)?$/i.test(r.type))
        .map((r) => resolveTarget(originPart, r.target));
    }
  }
  if (!specPaths.length) {
    specPaths = zip.names.filter((n) => /\.(aas\.xml|aas\.json)$/i.test(n) || /environment\.(xml|json)$/i.test(n));
  }
  if (!specPaths.length) throw new Error('No AAS environment part found in this package');
  return specPaths;
}

// ---------------------------------------------------------------------
// XML -> rich element tree (preserves semanticId/category/lang-strings,
// unlike the simplified model used by the viewer - the generator needs
// to write a faithful instance back out, not just display one).
// ---------------------------------------------------------------------

const REPEATABLE = new Set([
  'assetAdministrationShell', 'submodel', 'conceptDescription', 'reference', 'key',
  'property', 'multiLanguageProperty', 'range', 'file', 'blob', 'referenceElement',
  'relationshipElement', 'annotatedRelationshipElement', 'submodelElementCollection',
  'submodelElementList', 'entity', 'operation', 'capability', 'basicEventElement',
  'langStringNameType', 'langStringTextType', 'specificAssetId', 'embeddedDataSpecification',
  'qualifier', 'statement', 'extension'
]);

const envParser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => REPEATABLE.has(name)
});

function asArray(x) { return x == null ? [] : (Array.isArray(x) ? x : [x]); }

function convertLangStrings(container) {
  if (!container) return undefined;
  const key = Object.keys(container).find((k) => k.startsWith('langString'));
  const items = key ? asArray(container[key]) : [];
  return items.map((it) => ({ language: it.language, text: it.text }));
}

function convertReference(refNode) {
  if (!refNode) return undefined;
  const keys = refNode.keys ? asArray(refNode.keys.key) : [];
  return { type: refNode.type, keys: keys.map((k) => ({ type: k.type, value: k.value })) };
}

const CHILD_TAGS = [
  'property', 'multiLanguageProperty', 'range', 'file', 'blob',
  'referenceElement', 'relationshipElement', 'annotatedRelationshipElement',
  'submodelElementCollection', 'submodelElementList', 'entity', 'operation',
  'capability', 'basicEventElement'
];

const TAG_TO_MODELTYPE = {
  property: 'Property', multiLanguageProperty: 'MultiLanguageProperty', range: 'Range',
  file: 'File', blob: 'Blob', referenceElement: 'ReferenceElement',
  relationshipElement: 'RelationshipElement', annotatedRelationshipElement: 'AnnotatedRelationshipElement',
  submodelElementCollection: 'SubmodelElementCollection', submodelElementList: 'SubmodelElementList',
  entity: 'Entity', operation: 'Operation', capability: 'Capability', basicEventElement: 'BasicEventElement'
};

function convertChildrenContainer(valueNode) {
  if (!valueNode) return [];
  const out = [];
  for (const tag of CHILD_TAGS) {
    if (valueNode[tag] !== undefined) {
      for (const child of asArray(valueNode[tag])) out.push(convertElement(tag, child));
    }
  }
  return out;
}

function convertElement(tag, node) {
  const modelType = TAG_TO_MODELTYPE[tag] || tag;
  const rich = {
    modelType,
    idShort: node.idShort || '',
    category: node.category || undefined,
    semanticId: convertReference(node.semanticId),
    displayName: convertLangStrings(node.displayName),
    description: convertLangStrings(node.description)
  };
  switch (tag) {
    case 'property':
      rich.valueType = node.valueType;
      rich.value = node.value != null ? String(node.value) : '';
      break;
    case 'multiLanguageProperty':
      rich.value = convertLangStrings(node.value) || [];
      break;
    case 'range':
      rich.valueType = node.valueType;
      rich.min = node.min != null ? String(node.min) : '';
      rich.max = node.max != null ? String(node.max) : '';
      break;
    case 'file':
      rich.value = node.value || '';
      rich.contentType = node.contentType || '';
      break;
    case 'blob':
      rich.contentType = node.contentType || '';
      rich.value = node.value || '';
      break;
    case 'referenceElement':
      rich.value = convertReference(node.value);
      break;
    case 'relationshipElement':
      rich.first = convertReference(node.first);
      rich.second = convertReference(node.second);
      break;
    case 'submodelElementCollection':
      rich.value = convertChildrenContainer(node.value);
      break;
    case 'submodelElementList':
      // typeValueListElement is required by the AAS schema on every SubmodelElementList;
      // valueTypeListElement/orderRelevant/semanticIdListElement are conditionally present.
      // These live as siblings of <value> in the XML, not inside it.
      rich.value = convertChildrenContainer(node.value);
      rich.typeValueListElement = node.typeValueListElement || undefined;
      rich.valueTypeListElement = node.valueTypeListElement || undefined;
      rich.orderRelevant = node.orderRelevant != null ? String(node.orderRelevant) === 'true' : undefined;
      rich.semanticIdListElement = convertReference(node.semanticIdListElement);
      break;
    default:
      rich.value = node.value;
  }
  return rich;
}

function convertSubmodel(node) {
  return {
    modelType: 'Submodel',
    id: node.id || '',
    idShort: node.idShort || '',
    category: node.category || undefined,
    kind: node.kind || undefined,
    semanticId: convertReference(node.semanticId),
    displayName: convertLangStrings(node.displayName),
    description: convertLangStrings(node.description),
    submodelElements: convertChildrenContainer(node.submodelElements)
  };
}

function convertShell(node) {
  const ai = node.assetInformation;
  return {
    modelType: 'AssetAdministrationShell',
    id: node.id || '',
    idShort: node.idShort || '',
    category: node.category || undefined,
    displayName: convertLangStrings(node.displayName),
    description: convertLangStrings(node.description),
    assetInformation: ai ? {
      assetKind: ai.assetKind || '',
      assetType: ai.assetType || undefined,
      globalAssetId: ai.globalAssetId || undefined,
      defaultThumbnail: ai.defaultThumbnail ? { path: ai.defaultThumbnail.path, contentType: ai.defaultThumbnail.contentType } : undefined
    } : undefined,
    submodelRefs: node.submodels ? asArray(node.submodels.reference).map(convertReference) : []
  };
}

function convertEmbeddedDataSpecification(node) {
  const out = { dataSpecification: convertReference(node.dataSpecification) };
  const iec = node.dataSpecificationContent ? node.dataSpecificationContent.dataSpecificationIec61360 : null;
  if (iec) {
    const content = { modelType: 'DataSpecificationIec61360' };
    const preferredName = convertLangStrings(iec.preferredName);
    if (preferredName && preferredName.length) content.preferredName = preferredName;
    const shortName = convertLangStrings(iec.shortName);
    if (shortName && shortName.length) content.shortName = shortName;
    if (iec.unit) content.unit = iec.unit;
    if (iec.dataType) content.dataType = iec.dataType;
    const definition = convertLangStrings(iec.definition);
    if (definition && definition.length) content.definition = definition;
    if (iec.valueFormat) content.valueFormat = iec.valueFormat;
    if (iec.symbol) content.symbol = iec.symbol;
    if (iec.sourceOfDefinition) content.sourceOfDefinition = iec.sourceOfDefinition;
    out.dataSpecificationContent = content;
  }
  return out;
}

function convertConceptDescription(node) {
  const cd = { id: node.id || '' };
  if (node.idShort) cd.idShort = node.idShort;
  if (node.category) cd.category = node.category;
  const description = convertLangStrings(node.description);
  if (description && description.length) cd.description = description;
  if (node.isCaseOf) {
    const isCaseOf = asArray(node.isCaseOf.reference).map(convertReference);
    if (isCaseOf.length) cd.isCaseOf = isCaseOf;
  }
  if (node.embeddedDataSpecifications) {
    const eds = asArray(node.embeddedDataSpecifications.embeddedDataSpecification).map(convertEmbeddedDataSpecification);
    if (eds.length) cd.embeddedDataSpecifications = eds;
  }
  return cd;
}

function xmlToRichEnvironment(xmlText) {
  const doc = envParser.parse(xmlText);
  const root = doc.environment;
  if (!root) throw new Error('XML root element is not <environment>');
  return {
    shells: root.assetAdministrationShells ? asArray(root.assetAdministrationShells.assetAdministrationShell).map(convertShell) : [],
    submodels: root.submodels ? asArray(root.submodels.submodel).map(convertSubmodel) : [],
    conceptDescriptions: root.conceptDescriptions ? asArray(root.conceptDescriptions.conceptDescription).map(convertConceptDescription) : []
  };
}

// ---------------------------------------------------------------------
// JSON -> rich element tree (AAS-JSON is already close to this shape)
// ---------------------------------------------------------------------

function normElementJson(e) {
  const rich = {
    modelType: e.modelType, idShort: e.idShort || '', category: e.category,
    semanticId: e.semanticId, displayName: e.displayName, description: e.description
  };
  switch (e.modelType) {
    case 'Property':
      rich.valueType = e.valueType; rich.value = e.value != null ? String(e.value) : '';
      break;
    case 'MultiLanguageProperty':
      rich.value = e.value || [];
      break;
    case 'Range':
      rich.valueType = e.valueType; rich.min = e.min; rich.max = e.max;
      break;
    case 'File':
    case 'Blob':
      rich.value = e.value; rich.contentType = e.contentType;
      break;
    case 'ReferenceElement':
      rich.value = e.value;
      break;
    case 'RelationshipElement':
      rich.first = e.first; rich.second = e.second;
      break;
    case 'SubmodelElementCollection':
      rich.value = (e.value || []).map(normElementJson);
      break;
    case 'SubmodelElementList':
      // typeValueListElement is required by the AAS schema on every SubmodelElementList;
      // valueTypeListElement/orderRelevant/semanticIdListElement are conditionally present.
      rich.value = (e.value || []).map(normElementJson);
      rich.typeValueListElement = e.typeValueListElement;
      rich.valueTypeListElement = e.valueTypeListElement;
      rich.orderRelevant = e.orderRelevant;
      rich.semanticIdListElement = e.semanticIdListElement;
      break;
    default:
      rich.value = e.value;
  }
  return rich;
}

function jsonToRichEnvironment(raw) {
  return {
    shells: (raw.assetAdministrationShells || []).map((sh) => ({
      modelType: 'AssetAdministrationShell', id: sh.id || '', idShort: sh.idShort || '',
      category: sh.category, displayName: sh.displayName, description: sh.description,
      assetInformation: sh.assetInformation, submodelRefs: sh.submodels || []
    })),
    submodels: (raw.submodels || []).map((sm) => ({
      modelType: 'Submodel', id: sm.id || '', idShort: sm.idShort || '',
      category: sm.category, kind: sm.kind, semanticId: sm.semanticId,
      displayName: sm.displayName, description: sm.description,
      submodelElements: (sm.submodelElements || []).map(normElementJson)
    })),
    conceptDescriptions: raw.conceptDescriptions || []
  };
}

// ---------------------------------------------------------------------
// Template parsing entry point
// ---------------------------------------------------------------------

function parseAasxTemplate(buffer) {
  const zip = openZip(buffer);
  const specPaths = resolveAasSpecParts(zip);
  const envs = specPaths.map((p) => {
    const text = zip.textFor(p);
    return /\.json$/i.test(p) ? jsonToRichEnvironment(JSON.parse(text)) : xmlToRichEnvironment(text);
  });

  const files = new Map();
  for (const name of zip.names) {
    if (/^_rels\//.test(name)) continue;
    if (/\/_rels\//.test(name)) continue;
    if (specPaths.includes(name)) continue;
    if (name === '[Content_Types].xml') continue;
    if (/aasx-origin$/.test(name)) continue;
    files.set(name, zip.bytesFor(name));
  }

  return {
    shells: [].concat(...envs.map((e) => e.shells)),
    submodels: [].concat(...envs.map((e) => e.submodels)),
    conceptDescriptions: [].concat(...envs.map((e) => e.conceptDescriptions || [])),
    files
  };
}

// ---------------------------------------------------------------------
// Leaf collection + value application
// ---------------------------------------------------------------------

const LEAF_TYPES = new Set(['Property', 'MultiLanguageProperty', 'Range', 'File']);

function collectLeaves(submodels) {
  const leaves = [];
  submodels.forEach((sm, smIdx) => {
    (function walk(nodes, path) {
      nodes.forEach((node, i) => {
        const nodePath = path.concat(i);
        if (LEAF_TYPES.has(node.modelType)) {
          leaves.push({
            key: smIdx + ':' + nodePath.join('.'),
            submodelIdx: smIdx,
            submodelIdShort: sm.idShort,
            path: nodePath,
            idShort: node.idShort,
            displayName: (node.displayName || []).map((d) => d.text).join(' / '),
            description: (node.description || []).map((d) => d.text).join(' / '),
            semanticId: node.semanticId ? (node.semanticId.keys || []).map((k) => k.value).join(' | ') : '',
            modelType: node.modelType,
            valueType: node.valueType || '',
            contentType: node.contentType || '',
            currentValue: node.modelType === 'Range' ? { min: node.min, max: node.max } : node.value
          });
        } else if (node.modelType === 'SubmodelElementCollection' || node.modelType === 'SubmodelElementList') {
          walk(node.value || [], nodePath);
        }
      });
    })(sm.submodelElements || [], []);
  });
  return leaves;
}

// The shell (AAS id/idShort) and its assetInformation carry the asset's own identity -
// separate from submodel data, but just as much a part of "the AAS" and just as much in
// need of being filled in per-instance rather than left as template placeholders.
// submodelIdx: -1 marks these as shell-scope leaves so callers can route them differently
// from ordinary submodel-element leaves (which share the same key/leaf shape otherwise).
const SHELL_FIELDS = [
  {
    field: 'id',
    label: 'AAS Identifier (id)',
    description: 'The globally unique identifier of this Asset Administration Shell instance - must be a valid, ' +
      'unique IRI. This is rarely stated in product documents; it is normally assigned when the instance is created.',
    valueType: 'xs:anyURI'
  },
  {
    field: 'idShort',
    label: 'AAS idShort',
    description: 'Short, human-readable name/ID for this AAS instance.',
    valueType: 'xs:string'
  },
  {
    field: 'assetKind',
    label: 'Asset Kind',
    description: 'Whether this AAS represents a specific physical Instance, a Type (blueprint/class), or ' +
      'NotApplicable. Value must be exactly one of: Instance, Type, NotApplicable.',
    valueType: 'xs:string'
  },
  {
    field: 'globalAssetId',
    label: 'Global Asset ID',
    description: 'The globally unique identifier of the physical asset itself (distinct from the AAS id) - often a ' +
      'manufacturer-issued URI built from the serial number.',
    valueType: 'xs:anyURI'
  },
  {
    field: 'assetType',
    label: 'Asset Type',
    description: 'Optional reference identifying the type/class this asset instance belongs to, e.g. a product or ' +
      'model identifier URI.',
    valueType: 'xs:anyURI'
  }
];

function collectShellLeaves(shells) {
  const leaves = [];
  shells.forEach((sh, shIdx) => {
    const ai = sh.assetInformation || {};
    const currentByField = { id: sh.id, idShort: sh.idShort, assetKind: ai.assetKind, globalAssetId: ai.globalAssetId, assetType: ai.assetType };
    SHELL_FIELDS.forEach((f) => {
      leaves.push({
        key: 'shell:' + shIdx + ':' + f.field,
        submodelIdx: -1,
        shellIdx: shIdx,
        field: f.field,
        submodelIdShort: 'AAS / Asset Information',
        idShort: f.field,
        displayName: f.label,
        description: f.description,
        semanticId: '',
        modelType: 'Property',
        valueType: f.valueType,
        currentValue: currentByField[f.field]
      });
    });
    // Modeled as a File leaf (not a SHELL_FIELDS property) so it rides the same extraction
    // and embed-on-generate path already built for image File elements below - the prompt's
    // "File elements whose contentType starts with image/" instructions apply here unchanged.
    leaves.push({
      key: 'shell:' + shIdx + ':thumbnail',
      submodelIdx: -1,
      shellIdx: shIdx,
      field: 'thumbnail',
      submodelIdShort: 'AAS / Asset Information',
      idShort: 'Thumbnail',
      displayName: 'Asset Thumbnail Image',
      description: 'A representative photo of this asset (e.g. a product shot) - stored as the AAS default thumbnail.',
      semanticId: '',
      modelType: 'File',
      contentType: (ai.defaultThumbnail && ai.defaultThumbnail.contentType) || 'image/png',
      currentValue: ai.defaultThumbnail ? ai.defaultThumbnail.path : undefined
    });
  });
  return leaves;
}

// id/idShort/assetKind are structurally required - unlike ordinary submodel data, an empty
// value here would make the output an invalid AAS, so a blank input keeps the template's
// original rather than being written out as null. globalAssetId/assetType are optional and
// follow the normal not-found -> omitted behavior - assetInformation is copied straight
// into the output JSON (not through serializeElement's null-to-omitted handling), so an
// unset field must be deleted here rather than set to null or it would serialize as a
// literal `null`, which strict AAS deserializers (e.g. BaSyx) reject.
function applyShellValue(shells, leaf, value) {
  const sh = shells[leaf.shellIdx];
  if (!sh) return;
  const provided = (value != null && String(value).trim() !== '') ? String(value).trim() : null;

  if (leaf.field === 'id') {
    sh.id = provided || sh.id;
  } else if (leaf.field === 'idShort') {
    sh.idShort = provided || sh.idShort;
  } else if (leaf.field === 'assetKind') {
    if (!sh.assetInformation) sh.assetInformation = {};
    sh.assetInformation.assetKind = provided || sh.assetInformation.assetKind || 'Instance';
  } else if (leaf.field === 'globalAssetId' || leaf.field === 'assetType') {
    if (!sh.assetInformation) sh.assetInformation = {};
    if (provided) sh.assetInformation[leaf.field] = provided;
    else delete sh.assetInformation[leaf.field];
  }
}

// defaultThumbnail is a Resource (path required, contentType optional) - unlike ordinary
// File elements it has no template placeholder to fall back on, so a blank value simply
// removes it rather than writing out a null placeholder.
function applyShellThumbnail(shells, leaf, value) {
  const sh = shells[leaf.shellIdx];
  if (!sh) return;
  if (!sh.assetInformation) sh.assetInformation = {};

  if (value && typeof value === 'object' && value.path) {
    sh.assetInformation.defaultThumbnail = { path: value.path, contentType: value.contentType };
    return;
  }

  const provided = (value != null && String(value).trim() !== '') ? String(value).trim() : null;
  if (provided) {
    const existing = sh.assetInformation.defaultThumbnail;
    sh.assetInformation.defaultThumbnail = { path: provided, contentType: existing ? existing.contentType : undefined };
  } else {
    delete sh.assetInformation.defaultThumbnail;
  }
}

function getNodeByPath(submodels, smIdx, path) {
  let nodes = submodels[smIdx].submodelElements;
  let node;
  for (let i = 0; i < path.length; i++) {
    node = nodes[path[i]];
    if (i < path.length - 1) nodes = node.value;
  }
  return node;
}

// AAS valueTypes (xsd) that hold numbers - used to decide the "not found" fallback below.
const NUMERIC_VALUE_TYPES = new Set([
  'xs:integer', 'xs:int', 'xs:long', 'xs:short', 'xs:byte',
  'xs:double', 'xs:float', 'xs:decimal',
  'xs:unsignedbyte', 'xs:unsignedint', 'xs:unsignedlong', 'xs:unsignedshort',
  'xs:negativeinteger', 'xs:nonnegativeinteger', 'xs:nonpositiveinteger', 'xs:positiveinteger'
]);
function isNumericType(valueType) {
  return NUMERIC_VALUE_TYPES.has(String(valueType || '').toLowerCase());
}

// Applies an extracted/edited value onto a template leaf. Anything left empty is written
// explicitly as null (text-like elements) or "0" (numeric elements) rather than falling
// back to whatever placeholder value the template happened to carry.
function applyValue(submodels, leaf, value) {
  const node = getNodeByPath(submodels, leaf.submodelIdx, leaf.path);
  if (!node) return;
  const emptyScalar = isNumericType(node.valueType) ? '0' : null;

  if (node.modelType === 'Range') {
    const min = value && typeof value === 'object' ? value.min : undefined;
    const max = value && typeof value === 'object' ? value.max : undefined;
    node.min = (min != null && min !== '') ? String(min) : emptyScalar;
    node.max = (max != null && max !== '') ? String(max) : emptyScalar;
  } else if (node.modelType === 'MultiLanguageProperty') {
    if (Array.isArray(value) && value.length) {
      node.value = value.map((v) => ({ language: v.language || 'en', text: String(v.text != null ? v.text : v) }));
    } else {
      node.value = null;
    }
  } else if (node.modelType === 'File') {
    // { path, contentType } means the caller already downloaded and embedded a new file
    // (see buildEmbeddedFilePath) - anything else is a plain passthrough string, which
    // covers both a manually-typed package path and "leave the template's existing file
    // reference alone" (its currentValue, pre-filled by the UI when nothing was found).
    if (value && typeof value === 'object' && value.path) {
      node.value = value.path;
      if (value.contentType) node.contentType = value.contentType;
    } else if (value != null && String(value).trim() !== '') {
      node.value = String(value).trim();
    } else {
      node.value = null;
    }
  } else {
    node.value = (value != null && value !== '') ? String(value) : emptyScalar;
  }
}

// Computes a package-internal part path for a newly downloaded/embedded file, e.g.
// "aasx/files/Nameplate/CompanyLogo.png" - grouped under the owning submodel so multiple
// image fields don't collide, sanitized to safe zip-entry characters.
function buildEmbeddedFilePath(leaf, ext) {
  const safeSubmodel = String(leaf.submodelIdShort || 'files').replace(/[^a-z0-9_-]/gi, '_');
  const safeName = String(leaf.idShort || 'file').replace(/[^a-z0-9_-]/gi, '_');
  return 'aasx/files/' + safeSubmodel + '/' + safeName + '.' + ext;
}

// ---------------------------------------------------------------------
// Rich tree -> AAS-JSON environment
// ---------------------------------------------------------------------

// value/min/max/contentType are all optional per the AAS schema - the correct way to
// represent "no value" in JSON is to omit the key entirely, not emit a literal null.
// Strict deserializers (e.g. BaSyx/aas4j) reject `"value": null` with a type error since
// they expect either a string or the key's absence. JSON.stringify drops undefined-valued
// keys automatically, so mapping our internal null-marker to undefined here is enough.
function orOmit(v) { return v == null ? undefined : v; }

function serializeElement(node) {
  const out = { modelType: node.modelType, idShort: node.idShort };
  if (node.category) out.category = node.category;
  if (node.semanticId) out.semanticId = node.semanticId;
  if (node.displayName && node.displayName.length) out.displayName = node.displayName;
  if (node.description && node.description.length) out.description = node.description;
  switch (node.modelType) {
    case 'Property':
      out.valueType = node.valueType; out.value = orOmit(node.value); break;
    case 'MultiLanguageProperty':
      out.value = orOmit(node.value); break;
    case 'Range':
      out.valueType = node.valueType; out.min = orOmit(node.min); out.max = orOmit(node.max); break;
    case 'File':
    case 'Blob':
      out.value = orOmit(node.value); out.contentType = orOmit(node.contentType); break;
    case 'ReferenceElement':
      out.value = node.value; break;
    case 'RelationshipElement':
      out.first = node.first; out.second = node.second; break;
    case 'SubmodelElementCollection':
      out.value = (node.value || []).map(serializeElement); break;
    case 'SubmodelElementList':
      out.value = (node.value || []).map(serializeElement);
      // typeValueListElement is required by the AAS schema - always emit it, falling back to
      // a safe default if the template was somehow missing it, rather than producing an
      // invalid package.
      out.typeValueListElement = node.typeValueListElement || 'SubmodelElementCollection';
      if (node.valueTypeListElement) out.valueTypeListElement = node.valueTypeListElement;
      if (node.orderRelevant != null) out.orderRelevant = node.orderRelevant;
      if (node.semanticIdListElement) out.semanticIdListElement = node.semanticIdListElement;
      break;
    default:
      if (node.value !== undefined) out.value = node.value;
  }
  return out;
}

function serializeSubmodel(sm) {
  const out = { modelType: 'Submodel', id: sm.id, idShort: sm.idShort };
  if (sm.category) out.category = sm.category;
  // Source templates (e.g. IDTA submodel templates) declare kind: "Template" because they
  // themselves are reusable template documents. This tool always produces a populated
  // instance of an actual asset, never another template, so the output must always be
  // kind: "Instance" regardless of what the template declared.
  out.kind = 'Instance';
  if (sm.semanticId) out.semanticId = sm.semanticId;
  if (sm.displayName && sm.displayName.length) out.displayName = sm.displayName;
  if (sm.description && sm.description.length) out.description = sm.description;
  out.submodelElements = (sm.submodelElements || []).map(serializeElement);
  return out;
}

function serializeShell(sh) {
  const out = { modelType: 'AssetAdministrationShell', id: sh.id, idShort: sh.idShort };
  if (sh.category) out.category = sh.category;
  if (sh.displayName && sh.displayName.length) out.displayName = sh.displayName;
  if (sh.description && sh.description.length) out.description = sh.description;
  if (sh.assetInformation) out.assetInformation = sh.assetInformation;
  out.submodels = (sh.submodelRefs || []).map((ref) => ({ type: 'ModelReference', keys: ref.keys }));
  return out;
}

function serializeConceptDescription(cd) {
  const out = { modelType: 'ConceptDescription', id: cd.id };
  if (cd.idShort) out.idShort = cd.idShort;
  if (cd.category) out.category = cd.category;
  if (cd.description && cd.description.length) out.description = cd.description;
  if (cd.isCaseOf && cd.isCaseOf.length) out.isCaseOf = cd.isCaseOf;
  if (cd.embeddedDataSpecifications && cd.embeddedDataSpecifications.length) out.embeddedDataSpecifications = cd.embeddedDataSpecifications;
  return out;
}

function toAasJson({ shells, submodels, conceptDescriptions }) {
  return {
    assetAdministrationShells: shells.map(serializeShell),
    submodels: submodels.map(serializeSubmodel),
    conceptDescriptions: (conceptDescriptions || []).map(serializeConceptDescription)
  };
}

// ---------------------------------------------------------------------
// Rich tree -> AAS-XML environment
//
// AASX Package Explorer's file-content viewer ("Show content") only sets its internal
// _openPackage handle inside the JSON branch of its spec-part loader, right after running
// the strict Jsonization.Deserialize.EnvironmentFrom(...) parser - the same deserializer
// class that rejected literal `null` values and a missing typeValueListElement earlier.
// Independent tools (BaSyx, our own reader) accept our JSON environment fine, but this one
// app's JSON path is evidently less battle-tested than its XML path. Real-world .aasx files
// (e.g. NEXO_Cordless_Nutrunner_v9.aasx) use XML and their embedded images open there without
// issue, so the generator writes AAS-XML instead of AAS-JSON - element order and tag names
// below are copied directly from that known-working file, not just the schema docs.
// ---------------------------------------------------------------------

function escXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function langStringsToXml(strings, itemTag, wrapperTag) {
  if (!strings || !strings.length) return '';
  const items = strings.map((s) => '<' + itemTag + '><language>' + escXml(s.language) + '</language><text>' + escXml(s.text) + '</text></' + itemTag + '>').join('');
  return '<' + wrapperTag + '>' + items + '</' + wrapperTag + '>';
}

function referenceToXml(ref, wrapperTag) {
  if (!ref) return '';
  const keys = (ref.keys || []).map((k) => '<key><type>' + escXml(k.type) + '</type><value>' + escXml(k.value) + '</value></key>').join('');
  return '<' + wrapperTag + '><type>' + escXml(ref.type) + '</type><keys>' + keys + '</keys></' + wrapperTag + '>';
}

const MODELTYPE_TO_TAG = {};
Object.keys(TAG_TO_MODELTYPE).forEach((tag) => { MODELTYPE_TO_TAG[TAG_TO_MODELTYPE[tag]] = tag; });

function serializeElementXml(node) {
  const tag = MODELTYPE_TO_TAG[node.modelType];
  if (!tag) return '';
  // Order matches the AAS metamodel attribute sequence as observed in a real, working file:
  // category, idShort, displayName, description, semanticId, then type-specific fields.
  let body = '';
  if (node.category) body += '<category>' + escXml(node.category) + '</category>';
  body += '<idShort>' + escXml(node.idShort) + '</idShort>';
  body += langStringsToXml(node.displayName, 'langStringNameType', 'displayName');
  body += langStringsToXml(node.description, 'langStringTextType', 'description');
  if (node.semanticId) body += referenceToXml(node.semanticId, 'semanticId');

  switch (node.modelType) {
    case 'Property':
      body += '<valueType>' + escXml(node.valueType) + '</valueType>';
      if (node.value != null) body += '<value>' + escXml(node.value) + '</value>';
      break;
    case 'MultiLanguageProperty':
      body += langStringsToXml(node.value, 'langStringTextType', 'value');
      break;
    case 'Range':
      body += '<valueType>' + escXml(node.valueType) + '</valueType>';
      if (node.min != null) body += '<min>' + escXml(node.min) + '</min>';
      if (node.max != null) body += '<max>' + escXml(node.max) + '</max>';
      break;
    case 'File':
    case 'Blob':
      if (node.value != null) body += '<value>' + escXml(node.value) + '</value>';
      if (node.contentType != null) body += '<contentType>' + escXml(node.contentType) + '</contentType>';
      break;
    case 'ReferenceElement':
      if (node.value) body += referenceToXml(node.value, 'value');
      break;
    case 'RelationshipElement':
      if (node.first) body += referenceToXml(node.first, 'first');
      if (node.second) body += referenceToXml(node.second, 'second');
      break;
    case 'SubmodelElementCollection':
      body += '<value>' + (node.value || []).map(serializeElementXml).join('') + '</value>';
      break;
    case 'SubmodelElementList':
      if (node.semanticIdListElement) body += referenceToXml(node.semanticIdListElement, 'semanticIdListElement');
      body += '<typeValueListElement>' + escXml(node.typeValueListElement || 'SubmodelElementCollection') + '</typeValueListElement>';
      if (node.valueTypeListElement) body += '<valueTypeListElement>' + escXml(node.valueTypeListElement) + '</valueTypeListElement>';
      if (node.orderRelevant != null) body += '<orderRelevant>' + (node.orderRelevant ? 'true' : 'false') + '</orderRelevant>';
      body += '<value>' + (node.value || []).map(serializeElementXml).join('') + '</value>';
      break;
    default:
      break;
  }
  return '<' + tag + '>' + body + '</' + tag + '>';
}

function serializeSubmodelXml(sm) {
  let body = '';
  if (sm.category) body += '<category>' + escXml(sm.category) + '</category>';
  body += '<idShort>' + escXml(sm.idShort) + '</idShort>';
  body += langStringsToXml(sm.displayName, 'langStringNameType', 'displayName');
  body += langStringsToXml(sm.description, 'langStringTextType', 'description');
  body += '<id>' + escXml(sm.id) + '</id>';
  body += '<kind>Instance</kind>'; // see serializeSubmodel's comment - always Instance in generator output
  if (sm.semanticId) body += referenceToXml(sm.semanticId, 'semanticId');
  body += '<submodelElements>' + (sm.submodelElements || []).map(serializeElementXml).join('') + '</submodelElements>';
  return '<submodel>' + body + '</submodel>';
}

function serializeShellXml(sh) {
  let body = '';
  if (sh.category) body += '<category>' + escXml(sh.category) + '</category>';
  body += '<idShort>' + escXml(sh.idShort) + '</idShort>';
  body += langStringsToXml(sh.displayName, 'langStringNameType', 'displayName');
  body += langStringsToXml(sh.description, 'langStringTextType', 'description');
  body += '<id>' + escXml(sh.id) + '</id>';
  const ai = sh.assetInformation || { assetKind: 'Instance' };
  let aiBody = '<assetKind>' + escXml(ai.assetKind || 'Instance') + '</assetKind>';
  if (ai.globalAssetId) aiBody += '<globalAssetId>' + escXml(ai.globalAssetId) + '</globalAssetId>';
  aiBody += '<specificAssetIds />';
  if (ai.assetType) aiBody += '<assetType>' + escXml(ai.assetType) + '</assetType>';
  if (ai.defaultThumbnail) {
    aiBody += '<defaultThumbnail><path>' + escXml(ai.defaultThumbnail.path) + '</path>';
    // contentType is optional on Resource (unlike the mandatory one on File submodel
    // elements) - emitting an empty tag when we don't know it would fail a strict
    // MimeType-pattern validator, so omit the element entirely instead.
    if (ai.defaultThumbnail.contentType) aiBody += '<contentType>' + escXml(ai.defaultThumbnail.contentType) + '</contentType>';
    aiBody += '</defaultThumbnail>';
  }
  body += '<assetInformation>' + aiBody + '</assetInformation>';
  body += '<submodels>' + (sh.submodelRefs || []).map((ref) => referenceToXml(ref, 'reference')).join('') + '</submodels>';
  return '<assetAdministrationShell>' + body + '</assetAdministrationShell>';
}

function serializeConceptDescriptionXml(cd) {
  let body = '';
  if (cd.category) body += '<category>' + escXml(cd.category) + '</category>';
  if (cd.idShort) body += '<idShort>' + escXml(cd.idShort) + '</idShort>';
  body += langStringsToXml(cd.description, 'langStringTextType', 'description');
  body += '<id>' + escXml(cd.id) + '</id>';
  return '<conceptDescription>' + body + '</conceptDescription>';
}

function toAasXml({ shells, submodels, conceptDescriptions }) {
  const shellsXml = shells.map(serializeShellXml).join('');
  const submodelsXml = submodels.map(serializeSubmodelXml).join('');
  const cdsXml = (conceptDescriptions || []).map(serializeConceptDescriptionXml).join('');
  return '<?xml version="1.0" encoding="utf-8"?><environment xmlns="https://admin-shell.io/aas/3/0">' +
    '<assetAdministrationShells>' + shellsXml + '</assetAdministrationShells>' +
    '<submodels>' + submodelsXml + '</submodels>' +
    '<conceptDescriptions>' + cdsXml + '</conceptDescriptions>' +
    '</environment>';
}

// ---------------------------------------------------------------------
// ZIP (OPC) writer
// ---------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function buildZipBuffer(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const e of entries) {
    const nameBytes = Buffer.from(e.name, 'utf-8');
    const method = e.method || 0;
    const crc = crc32(e.data);
    const compData = method === 8 ? zlib.deflateRawSync(e.data) : e.data;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compData.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    const localEntry = Buffer.concat([local, nameBytes, compData]);
    localParts.push(localEntry);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compData.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(Buffer.concat([central, nameBytes]));

    offset += localEntry.length;
  }

  const cdStart = offset;
  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(cdStart, 16);

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

const CONTENT_TYPE_MAP = {
  rels: 'application/vnd.openxmlformats-package.relationships+xml',
  xml: 'text/xml', json: 'application/json', // text/xml matches real-world .aasx files exactly
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', svg: 'image/svg+xml',
  webp: 'image/webp', bmp: 'image/bmp', tiff: 'image/tiff', ico: 'image/x-icon',
  pdf: 'application/pdf', txt: 'text/plain'
};

function buildAasxBuffer(richEnv, templateFiles) {
  // AAS-XML, not AAS-JSON - see the comment above toAasXml for why.
  const envXml = toAasXml(richEnv);
  const envPath = 'aasx/data/environment.aas.xml';
  const envPartName = envPath.split('/').pop();

  // If the shell carries a defaultThumbnail whose file is actually embedded, also wire it
  // up as the package's own OPC-level thumbnail relationship - this is what makes Windows
  // Explorer and AASX Package Explorer show a preview thumbnail for the .aasx file itself,
  // on top of the AAS-spec-level assetInformation.defaultThumbnail reference.
  const thumb = richEnv.shells && richEnv.shells[0] && richEnv.shells[0].assetInformation && richEnv.shells[0].assetInformation.defaultThumbnail;
  const thumbPath = thumb && thumb.path ? stripSlash(thumb.path) : null;
  const hasThumbFile = !!(thumbPath && templateFiles && templateFiles.has(thumbPath));

  const rootRelParts = ['<Relationship Type="http://admin-shell.io/aasx/relationships/aasx-origin" Target="/aasx/aasx-origin" Id="R1"/>'];
  if (hasThumbFile) {
    rootRelParts.push('<Relationship Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail" Target="/' + thumbPath + '" Id="R2"/>');
  }
  const rootRels = '<?xml version="1.0" encoding="utf-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + rootRelParts.join('') + '</Relationships>';
  const originRels = '<?xml version="1.0" encoding="utf-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Type="http://admin-shell.io/aasx/relationships/aas-spec" Target="/' + envPath + '" Id="R2"/></Relationships>';

  const entries = [
    { name: '_rels/.rels', data: Buffer.from(rootRels, 'utf-8'), method: 8 },
    { name: 'aasx/aasx-origin', data: Buffer.from('AASX-Origin', 'utf-8'), method: 8 },
    { name: 'aasx/_rels/aasx-origin.rels', data: Buffer.from(originRels, 'utf-8'), method: 8 },
    { name: envPath, data: Buffer.from(envXml, 'utf-8'), method: 8 }
  ];

  const extTypes = new Set(['json', 'xml', 'rels']);
  if (templateFiles) {
    let relId = 3; // R1/R2 already used by aasx-origin/aas-spec above
    const supplRels = [];
    for (const [name, data] of templateFiles) {
      entries.push({ name, data, method: 8 });
      const ext = name.split('.').pop().toLowerCase();
      extTypes.add(ext);
      // Files referenced by File submodel elements (images, PDFs...) are otherwise "loose"
      // parts with nothing pointing to them - some OPC readers (e.g. AASX Package
      // Explorer's content viewer) resolve supplementary files by walking relationships
      // rather than doing a raw absolute-URI lookup, and fail to open an unreachable part
      // even though it physically exists in the zip and the AAS environment references its
      // path.
      supplRels.push('<Relationship Type="http://admin-shell.io/aasx/relationships/aas-suppl" Target="/' + name + '" Id="R' + (relId++) + '"/>');
    }
    if (supplRels.length) {
      const specRelsXml = '<?xml version="1.0" encoding="utf-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + supplRels.join('') + '</Relationships>';
      entries.push({ name: 'aasx/data/_rels/' + envPartName + '.rels', data: Buffer.from(specRelsXml, 'utf-8'), method: 8 });
    }
  }

  const defaults = Array.from(extTypes)
    .map((ext) => '<Default Extension="' + ext + '" ContentType="' + (CONTENT_TYPE_MAP[ext] || 'application/octet-stream') + '"/>')
    .join('');
  // aasx/aasx-origin has no file extension, so it can never be matched by a Default
  // Extension entry above - strict OPC readers (e.g. AASX Package Explorer, which uses
  // .NET's System.IO.Packaging) require every part to resolve to a content type and will
  // fail to even read the root relationships without this, surfacing as a generic
  // "Unable to find AASX origin" error.
  const overrides = '<Override PartName="/aasx/aasx-origin" ContentType="text/plain"/>';
  const contentTypesXml = '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' + defaults + overrides + '</Types>';
  entries.push({ name: '[Content_Types].xml', data: Buffer.from(contentTypesXml, 'utf-8'), method: 8 });

  return buildZipBuffer(entries);
}

module.exports = {
  parseAasxTemplate,
  collectLeaves,
  collectShellLeaves,
  applyValue,
  applyShellValue,
  applyShellThumbnail,
  buildEmbeddedFilePath,
  buildAasxBuffer
};
