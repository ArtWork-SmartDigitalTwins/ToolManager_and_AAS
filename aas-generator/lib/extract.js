'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.AAS_MODEL || 'claude-sonnet-5';
const MAX_DOC_CHARS = 150000;
const MAX_SEARCH_ROUNDS = 6; // caps resend loops if the server-side search tool pauses repeatedly
// Server-side web_search/web_fetch results land in the same response's content and count
// against max_tokens - with search enabled a submodel can easily need far more headroom
// than the plain extraction case, or the model runs out of budget before it can call
// submit_extracted_values and the whole submodel silently comes back empty.
const MAX_TOKENS = 4096;
const MAX_TOKENS_WITH_SEARCH = 16000;

function getClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set. Add it to your .env file and restart the server.');
  return new Anthropic({ apiKey });
}

function buildDocumentContext(documents) {
  let text = documents.map((d) => '## Source: ' + d.name + '\n' + d.text).join('\n\n');
  if (text.length > MAX_DOC_CHARS) text = text.slice(0, MAX_DOC_CHARS) + '\n...[truncated]';
  return text;
}

const EXTRACTION_TOOL = {
  name: 'submit_extracted_values',
  description: 'Submit the final extracted value for each requested AAS element. Call this once, after you have gathered everything you can from the documents (and the web, if you used it).',
  input_schema: {
    type: 'object',
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string' },
            found: { type: 'boolean', description: 'true only if you actually found this information' },
            value: { type: 'string', description: 'The extracted value as plain text, formatted per the rules given in the prompt' },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
            evidence: { type: 'string', description: 'A short quote or citation supporting this value (source document name, or the web page it came from)' }
          },
          required: ['key', 'found']
        }
      }
    },
    required: ['results']
  }
};

// Server-side tools: Anthropic runs the search/fetch and returns results as
// content blocks in the same request - no client-side execution needed.
const WEB_TOOLS = [
  { type: 'web_search_20260209', name: 'web_search', max_uses: 5 },
  { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 5 }
];

async function extractForSubmodel(client, submodel, leaves, documentContext, useWebSearch, assetName) {
  if (!leaves.length) return { results: [], searches: 0 };

  const elementList = leaves.map((l) => ({
    key: l.key,
    label: l.displayName || l.idShort,
    description: l.description,
    semanticId: l.semanticId,
    modelType: l.modelType,
    valueType: l.valueType,
    contentType: l.contentType || undefined
  }));

  const assetLine = assetName
    ? 'The target asset is: "' + assetName + '". If the source documents or search results cover more than one ' +
      'product, variant, or model, only extract values that apply to this specific asset - ignore data for other ' +
      'products even if they appear in the same document.\n\n'
    : '';

  const researchInstructions = useWebSearch
    ? 'Check the source documents first. If an element is not covered there, you may use web_search to find it' +
      (assetName ? ' (search specifically for "' + assetName + '")' : '') + ', ' +
      'and web_fetch to read a specific page in full - prefer official manufacturer, standards, or datasheet sources ' +
      'over generic results. Do not search for things the documents already answer. Once you have gathered what you ' +
      'reasonably can, call submit_extracted_values exactly once with your final results.'
    : 'Only use the source documents below - never invent or guess a value.';

  const prompt = 'You are filling in an Asset Administration Shell (AAS) submodel called "' + submodel.idShort + '" ' +
    'from a set of source documents describing a physical asset.\n\n' + assetLine +
    'For each element below, find its value. ' + researchInstructions + ' If a value truly cannot be found, set found=false. ' +
    'Some elements represent real-time/operational data (e.g. current battery level, live status, a sensor reading, ' +
    'an operating counter) rather than fixed nameplate or technical-data facts - the correct value for these can only ' +
    'come from the live asset, not from a document. Set found=false for these even if a document shows an example or ' +
    'default number for it.\n\n' +
    'Formatting rules for the "value" field:\n' +
    '- Range elements: "min|max" (e.g. "1.8|64.5")\n' +
    '- MultiLanguageProperty elements: "en:<text>; de:<text>" (only include languages you actually have text for)\n' +
    '- xs:anyURI elements that should point to the product\'s own web page: if you use web_fetch to open that page, ' +
    'the value is simply the exact address you fetched - use that, do not try to copy a URL out of the page\'s ' +
    'rendered text or links, since that text can run together with unrelated page content (e.g. an image gallery\'s ' +
    '"1/6" counter) and produce a corrupted URL. If you only have it from a web_search result, use the exact URL ' +
    'from that result\'s link field. Don\'t skip the search step for this out of excess caution - actively look it up if ' +
    'it is not in the documents; only set found=false if a real search genuinely turns up no page for this asset.\n' +
    '- File elements whose contentType starts with "image/" (e.g. a company logo, product photo, CE/UKCA marking): ' +
    'search for and provide a direct URL to a suitable image as the value - it must resolve directly to image bytes ' +
    '(typically ending in .png/.jpg/.svg/etc.), not a webpage that merely displays the image somewhere in its layout. ' +
    'The URL must be hosted on the manufacturer\'s own domain (their official website, press kit, or CDN subdomain) ' +
    'or a standards body\'s own domain for a compliance marking (e.g. a UKCA/CE mark from a standards site) - never a ' +
    'third-party "free logo/icon" aggregator site (e.g. clearbit.com, freebiesupply.com, seeklogo.com, iconfinder.com, ' +
    'wikimedia/wikipedia, brandfetch, vectorlogo sites, etc.); those are frequently unreachable from a client network, ' +
    'go stale, or serve the wrong/outdated mark, even when they resolve. If you cannot find one directly on the ' +
    'manufacturer\'s or standard body\'s own domain, set found=false rather than substitute a third-party mirror. For a ' +
    'logo prefer a clean version (transparent or plain background) over a screenshot. Actively search for these too - ' +
    'do not skip just because it is an image. File elements whose contentType is not an image (e.g. a PDF manual) ' +
    'cannot be filled this way - set found=false for those unless a document/search literally gives you its exact URL.\n' +
    '- Everything else: plain text matching the element\'s valueType (numbers as plain numbers, dates as YYYY-MM-DD)\n\n' +
    'Elements to fill:\n' + JSON.stringify(elementList, null, 2);

  const tools = useWebSearch ? [EXTRACTION_TOOL, ...WEB_TOOLS] : [EXTRACTION_TOOL];
  // "any" (vs forcing submit_extracted_values) lets Claude reach for web_search/web_fetch
  // first and only call submit_extracted_values once it's actually done researching.
  const toolChoice = useWebSearch ? { type: 'any' } : { type: 'tool', name: 'submit_extracted_values' };

  const maxTokens = useWebSearch ? MAX_TOKENS_WITH_SEARCH : MAX_TOKENS;

  // A cache_control breakpoint caches everything from the start of the request up through
  // that block. We put one at the end of every message we won't touch again, so the next
  // request in this chain only pays full price for whatever's genuinely new since then:
  // - the document block (shared across every submodel group's call, not just resends)
  // - the end of the initial user message (lets resend #1 reuse the whole prompt as one unit)
  // - the end of the latest assistant turn on every resend (lets resend #2+ reuse everything
  //   up to the previous round instead of re-billing the whole growing search transcript)
  function withCacheBreakpoint(block) {
    return Object.assign({}, block, { cache_control: { type: 'ephemeral' } });
  }

  let messages = [{
    role: 'user',
    content: [
      { type: 'text', text: 'Source documents:\n' + documentContext, cache_control: { type: 'ephemeral' } },
      withCacheBreakpoint({ type: 'text', text: prompt })
    ]
  }];
  let resp = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    output_config: { effort: 'medium' },
    tools,
    tool_choice: toolChoice,
    messages
  });

  // Server-side web tools can run several search rounds internally; if they hit the
  // internal round limit mid-task the API returns pause_turn and expects a resend
  // (not a new "continue" message) to pick back up where it left off.
  let rounds = 0;
  while (resp.stop_reason === 'pause_turn' && rounds < MAX_SEARCH_ROUNDS) {
    rounds++;
    const assistantContent = resp.content.slice();
    if (assistantContent.length) {
      assistantContent[assistantContent.length - 1] = withCacheBreakpoint(assistantContent[assistantContent.length - 1]);
    }
    messages = [messages[0], { role: 'assistant', content: assistantContent }];
    resp = await client.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      output_config: { effort: 'medium' },
      tools,
      tool_choice: toolChoice,
      messages
    });
  }

  const searches = resp.content.filter((b) => b.type === 'server_tool_use').length;
  const toolUse = resp.content.find((b) => b.type === 'tool_use' && b.name === 'submit_extracted_values');
  // If the model ran out of budget (lots of search-result content) before it could call
  // submit_extracted_values, don't silently report every field in this submodel as
  // not-found - flag it so the caller can surface a real warning instead.
  const truncated = !toolUse && resp.stop_reason === 'max_tokens';
  return { results: toolUse ? (toolUse.input.results || []) : [], searches, truncated };
}

function parseValue(leaf, raw) {
  if (raw == null) return null;
  if (leaf.modelType === 'Range') {
    const [min, max] = String(raw).split('|').map((s) => s.trim());
    return { min, max };
  }
  if (leaf.modelType === 'MultiLanguageProperty') {
    return String(raw)
      .split(';')
      .map((part) => {
        const idx = part.indexOf(':');
        if (idx === -1) return { language: 'en', text: part.trim() };
        return { language: part.slice(0, idx).trim(), text: part.slice(idx + 1).trim() };
      })
      .filter((x) => x.text);
  }
  return raw;
}

async function extractAllValues(submodels, leaves, documents, useWebSearch, assetName, onProgress) {
  const client = getClient();
  const documentContext = buildDocumentContext(documents);
  const results = [];
  let totalSearches = 0;
  const truncatedSubmodels = [];
  let processedLeafCount = 0;
  const totalLeafCount = leaves.length;

  async function runGroup(pseudoSubmodel, groupLeaves) {
    if (!groupLeaves.length) return;

    onProgress && onProgress({
      total: totalLeafCount,
      processed: processedLeafCount,
      current: pseudoSubmodel && pseudoSubmodel.idShort ? pseudoSubmodel.idShort : 'Processing fields',
      groupSize: groupLeaves.length
    });

    const { results: raw, searches, truncated } = await extractForSubmodel(client, pseudoSubmodel, groupLeaves, documentContext, !!useWebSearch, assetName);
    totalSearches += searches;
    if (truncated) truncatedSubmodels.push(pseudoSubmodel.idShort);
    for (const r of raw) {
      const leaf = groupLeaves.find((l) => l.key === r.key);
      if (!leaf) continue;
      results.push({
        key: r.key,
        found: !!r.found,
        value: r.found ? parseValue(leaf, r.value) : null,
        confidence: r.confidence || 'low',
        evidence: r.evidence || ''
      });
    }

    processedLeafCount += groupLeaves.length;
    onProgress && onProgress({
      total: totalLeafCount,
      processed: processedLeafCount,
      current: pseudoSubmodel && pseudoSubmodel.idShort ? pseudoSubmodel.idShort : 'Processing fields',
      groupSize: groupLeaves.length
    });
  }

  for (let i = 0; i < submodels.length; i++) {
    await runGroup(submodels[i], leaves.filter((l) => l.submodelIdx === i));
  }
  // Shell-scope leaves (id/idShort/assetInformation) carry submodelIdx: -1 and don't belong
  // to any submodel - run them as their own group.
  await runGroup({ idShort: 'Asset Administration Shell (top-level identification)' }, leaves.filter((l) => l.submodelIdx === -1));

  return { results, searches: totalSearches, truncatedSubmodels };
}

module.exports = { extractAllValues };
