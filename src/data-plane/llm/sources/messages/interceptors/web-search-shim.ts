import { MESSAGES_WEB_SEARCH_ERROR_CODES } from '../../../../shared/protocol/messages.ts';
import type {
  MessagesAssistantContentBlock,
  MessagesClientTool,
  MessagesMessage,
  MessagesNativeWebSearchTool,
  MessagesPayload,
  MessagesResponse,
  MessagesSearchResultBlock,
  MessagesStreamEventData,
  MessagesTextBlock,
  MessagesTextCitation,
  MessagesTool,
  MessagesToolResultBlock,
  MessagesUserContentBlock,
  MessagesWebSearchErrorCode,
  MessagesWebSearchResultBlock,
  MessagesWebSearchToolResultError,
} from '../../../../shared/protocol/messages.ts';
import { resolveConfiguredWebSearchProvider, type WebSearchProvider } from '../../../../tools/web-search/provider.ts';
import { loadSearchConfig } from '../../../../tools/web-search/search-config.ts';
import { searchWebAndRecordUsage, searchWebWithoutRecordingUsage } from '../../../../tools/web-search/search.ts';
import type { WebSearchProviderName, WebSearchProviderRequest, WebSearchProviderResult } from '../../../../tools/web-search/types.ts';
import type { MessagesInterceptor } from '../../../interceptors.ts';
import { toInternalDebugError } from '../../../shared/errors/internal-debug-error.ts';
import { internalErrorResult } from '../../../shared/errors/result.ts';
import { messagesResultToEvents } from '../../../shared/protocol/messages.ts';
import { type ProtocolFrame } from '../../../shared/stream/types.ts';
import { collectMessagesProtocolEventsToResponse } from '../events/to-response.ts';

const MAX_QUERY_LENGTH = 1000;
const WEB_SEARCH_TOOL_NAME = 'web_search';
const PAYLOAD_PREFIX = 'cgws1';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

type SearchResultOwnership = 'owned' | 'foreign';

type NativeWebSearchToolVersion = MessagesNativeWebSearchTool['type'];

interface ShimWebSearchResultPayload {
  content: Array<{ type: 'text'; text: string }>;
}

interface ShimWebSearchCitationPayload {
  search_result_index: number;
  start_block_index: number;
  end_block_index: number;
}

interface OwnedReplayToolResult {
  upstreamToolResult: MessagesToolResultBlock;
  searchResultOwnership: SearchResultOwnership[];
}

interface ReplayAwareMessagesWebSearchShimState {
  priorSearchUseCount: number;
  requestSearchResultOwnership: SearchResultOwnership[];
}

interface ActiveMessagesWebSearchProvider {
  providerName: WebSearchProviderName;
  search: WebSearchProvider;
  apiKeyId?: string;
}

export type MessagesWebSearchShimState =
  | {
    mode: 'inactive';
  }
  | ({
    mode: 'replay_only';
  } & ReplayAwareMessagesWebSearchShimState)
  | ({
    mode: 'active';
    toolVersion: NativeWebSearchToolVersion;
    maxUses?: number;
    allowedDomains?: string[];
    blockedDomains?: string[];
    userLocation?: {
      city?: string;
      region?: string;
      country?: string;
      timezone?: string;
    };
  } & ReplayAwareMessagesWebSearchShimState);

export type PrepareMessagesWebSearchShimRequestResult =
  | {
    type: 'ok';
    payload: MessagesPayload;
    state: MessagesWebSearchShimState;
  }
  | {
    type: 'invalid-request';
    message: string;
  };

const inactiveMessagesWebSearchShimState = (): MessagesWebSearchShimState => ({
  mode: 'inactive',
});

// Official Anthropic API exposes native web_search to the model with this
// description and query-only input schema, and requires the native tool name to
// be exactly `web_search` when present.
const buildUpstreamWebSearchToolDefinition = (): MessagesClientTool => ({
  name: WEB_SEARCH_TOOL_NAME,
  description: 'The web_search tool searches the internet and returns up-to-date information from web sources.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query',
      },
    },
    required: ['query'],
  },
});

const normalizeNonEmptyDomainList = (domains?: string[]): string[] | undefined => {
  const normalized = domains?.map(domain => domain.trim()).filter(domain => domain.length > 0);
  return normalized && normalized.length > 0 ? [...new Set(normalized)] : undefined;
};

const bytesToBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

const base64UrlToBytes = (value: string): Uint8Array | null => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);

  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, char => char.charCodeAt(0));
  } catch {
    return null;
  }
};

const encodePayload = (payload: unknown): string => `${PAYLOAD_PREFIX}.${bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)))}`;

const decodePayload = (value: string): unknown | null => {
  const [prefix, encoded, ...rest] = value.split('.');
  if (prefix !== PAYLOAD_PREFIX || !encoded || rest.length > 0) {
    return null;
  }

  const bytes = base64UrlToBytes(encoded);
  if (!bytes) {
    return null;
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
};

const hasExactKeys = (value: Record<string, unknown>, keys: string[]): boolean => {
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && actualKeys.every(key => keys.includes(key));
};

const isNonNegativeInteger = (value: unknown): value is number => Number.isInteger(value) && typeof value === 'number' && value >= 0;

const isShimWebSearchResultPayload = (value: unknown): value is ShimWebSearchResultPayload => {
  if (!(value && typeof value === 'object' && 'content' in value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  if (!hasExactKeys(record, ['content'])) {
    return false;
  }

  const content = record.content;
  return Array.isArray(content) && content.every(block => block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string');
};

const isShimWebSearchCitationPayload = (value: unknown): value is ShimWebSearchCitationPayload => {
  if (!isRecord(value)) {
    return false;
  }

  if (!hasExactKeys(value, ['search_result_index', 'start_block_index', 'end_block_index'])) {
    return false;
  }

  return (
    isNonNegativeInteger(value.search_result_index) && isNonNegativeInteger(value.start_block_index) && isNonNegativeInteger(value.end_block_index) && value.end_block_index >= value.start_block_index
  );
};

export const encodeWebSearchResultPayload = (payload: ShimWebSearchResultPayload): string => encodePayload({ content: payload.content });

export const decodeWebSearchResultPayload = (value: string): ShimWebSearchResultPayload | null => {
  const decoded = decodePayload(value);
  return isShimWebSearchResultPayload(decoded) ? decoded : null;
};

export const encodeWebSearchCitationPayload = (payload: ShimWebSearchCitationPayload): string =>
  encodePayload({
    search_result_index: payload.search_result_index,
    start_block_index: payload.start_block_index,
    end_block_index: payload.end_block_index,
  });

export const decodeWebSearchCitationPayload = (value: string): ShimWebSearchCitationPayload | null => {
  const decoded = decodePayload(value);
  return isShimWebSearchCitationPayload(decoded) ? decoded : null;
};

const isNativeWebSearchToolDefinition = (tool: MessagesTool): tool is MessagesNativeWebSearchTool => tool.type === 'web_search_20250305' || tool.type === 'web_search_20260209';

const messagesWebSearchErrorCodeSet = new Set<string>(MESSAGES_WEB_SEARCH_ERROR_CODES);

const isMessagesWebSearchErrorCode = (value: unknown): value is MessagesWebSearchErrorCode => typeof value === 'string' && messagesWebSearchErrorCodeSet.has(value);

const isWebSearchToolResultError = (value: unknown): value is MessagesWebSearchToolResultError =>
  isRecord(value) && value.type === 'web_search_tool_result_error' && isMessagesWebSearchErrorCode(value.error_code);

const toUpstreamToolUseId = (toolUseId: string): string => (toolUseId.startsWith('srvtoolu_') ? `toolu_${toolUseId.slice('srvtoolu_'.length)}` : toolUseId);

const toNativeServerToolUseId = (toolUseId: string): string => (toolUseId.startsWith('toolu_') ? `srvtoolu_${toolUseId.slice('toolu_'.length)}` : toolUseId);

const toUserContentBlocks = (content: string | MessagesUserContentBlock[]): MessagesUserContentBlock[] => (typeof content === 'string' ? [{ type: 'text', text: content }] : [...content]);

const mapTextBlockCitations = (block: MessagesTextBlock, mapCitation: (citation: MessagesTextCitation) => MessagesTextCitation): MessagesTextBlock => ({
  type: 'text',
  text: block.text,
  ...(block.citations ? { citations: block.citations.map(mapCitation) } : {}),
});

const buildUpstreamSearchResultBlock = (result: MessagesWebSearchResultBlock, decoded: NonNullable<ReturnType<typeof decodeWebSearchResultPayload>>): MessagesSearchResultBlock => ({
  type: 'search_result',
  source: result.url,
  title: result.title,
  content: decoded.content,
  citations: { enabled: true },
});

const buildUserToolResultMessage = (toolResults: MessagesToolResultBlock[]): Extract<MessagesMessage, { role: 'user' }> => ({
  role: 'user',
  content: toolResults,
});

const buildNativeWebSearchErrorPayload = (errorCode: MessagesWebSearchErrorCode): MessagesWebSearchToolResultError => ({
  type: 'web_search_tool_result_error',
  error_code: errorCode,
});

const buildNativeWebSearchErrorResultBlock = (toolUseId: string, errorCode: MessagesWebSearchErrorCode): Extract<MessagesAssistantContentBlock, { type: 'web_search_tool_result' }> => ({
  type: 'web_search_tool_result',
  tool_use_id: toNativeServerToolUseId(toolUseId),
  content: buildNativeWebSearchErrorPayload(errorCode),
  caller: { type: 'direct' },
});

const buildNativeWebSearchServerToolUseBlock = (toolUseId: string, query: string): Extract<MessagesAssistantContentBlock, { type: 'server_tool_use' }> => ({
  type: 'server_tool_use',
  id: toNativeServerToolUseId(toolUseId),
  name: WEB_SEARCH_TOOL_NAME,
  input: { query },
});

const buildNativeWebSearchResultBlock = (result: Extract<WebSearchProviderResult, { type: 'ok' }>['results'][number]): MessagesWebSearchResultBlock => ({
  type: 'web_search_result',
  url: result.source,
  title: result.title,
  encrypted_content: encodeWebSearchResultPayload({
    content: result.content,
  }),
  ...(result.pageAge ? { page_age: result.pageAge } : {}),
});

// Error-only replay blocks do not carry our encoded payload marker, so the
// safest replay rule is structural: only decode results that are paired with
// a same-message `server_tool_use` we can turn back into upstream tool history.
const collectOwnedReplayResultsByServerToolUseId = (content: MessagesAssistantContentBlock[]): Map<string, OwnedReplayToolResult> => {
  const pairedServerToolUseIds = new Set(content.flatMap(block => (block.type === 'server_tool_use' && block.name === WEB_SEARCH_TOOL_NAME ? [block.id] : [])));
  const ownedReplayResultsByServerToolUseId = new Map<string, OwnedReplayToolResult>();

  for (const block of content) {
    if (block.type !== 'web_search_tool_result' || !pairedServerToolUseIds.has(block.tool_use_id)) {
      continue;
    }

    const ownedReplayResult = decodeOwnedReplayToolResult(block);
    if (!ownedReplayResult) {
      continue;
    }

    ownedReplayResultsByServerToolUseId.set(block.tool_use_id, ownedReplayResult);
  }

  return ownedReplayResultsByServerToolUseId;
};

const messageHasOwnedReplayMarkers = (message: MessagesMessage): boolean => {
  if (message.role !== 'assistant' || !Array.isArray(message.content)) {
    return false;
  }

  return (
    collectOwnedReplayResultsByServerToolUseId(message.content).size > 0 ||
    message.content.some(block => {
      if (block.type !== 'text' || !block.citations) {
        return false;
      }

      return block.citations.some(citation => citation.type === 'web_search_result_location' && decodeWebSearchCitationPayload(citation.encrypted_index) !== null);
    })
  );
};

const decodeOwnedReplayCitation = (citation: MessagesTextCitation): MessagesTextCitation => {
  if (citation.type !== 'web_search_result_location') {
    return citation;
  }

  const decoded = decodeWebSearchCitationPayload(citation.encrypted_index);
  if (!decoded) {
    return citation;
  }

  return {
    type: 'search_result_location',
    url: citation.url,
    title: citation.title,
    search_result_index: decoded.search_result_index,
    start_block_index: decoded.start_block_index,
    end_block_index: decoded.end_block_index,
    ...(citation.cited_text ? { cited_text: citation.cited_text } : {}),
  };
};

const decodeOwnedReplayToolResult = (block: Extract<MessagesAssistantContentBlock, { type: 'web_search_tool_result' }>): OwnedReplayToolResult | null => {
  if (Array.isArray(block.content)) {
    const decodedResults = block.content.map(result => ({
      result,
      payload: decodeWebSearchResultPayload(result.encrypted_content),
    }));

    if (decodedResults.some(entry => entry.payload === null)) {
      return null;
    }

    return {
      upstreamToolResult: {
        type: 'tool_result',
        tool_use_id: toUpstreamToolUseId(block.tool_use_id),
        content: decodedResults.map(({ result, payload }) => buildUpstreamSearchResultBlock(result, payload!)),
      },
      searchResultOwnership: decodedResults.map(() => 'owned'),
    };
  }

  if (isWebSearchToolResultError(block.content)) {
    // Intentionally do not decode or rewrite native-looking
    // `web_search_tool_result_error` history. Copilot upstream accepts the
    // Anthropic API-reference error-code payloads directly, and downstream-
    // supplied native error history is downstream-owned. This shim only
    // rewrites result arrays that carry our unsigned cgws1 replay payload.
    return null;
  }

  return null;
};

const collectForeignSearchResultOwnership = (content: string | MessagesUserContentBlock[]): SearchResultOwnership[] => {
  if (typeof content === 'string') {
    return [];
  }

  return content.flatMap(block => {
    if (block.type !== 'tool_result' || !Array.isArray(block.content)) {
      return [];
    }

    return block.content.flatMap(contentBlock => (contentBlock.type === 'search_result' ? ['foreign' as const] : []));
  });
};

const prependToolResultsToUserMessage = (message: Extract<MessagesMessage, { role: 'user' }>, toolResults: MessagesToolResultBlock[]): Extract<MessagesMessage, { role: 'user' }> => ({
  role: 'user',
  content: [...toolResults, ...toUserContentBlocks(message.content)],
});

const canPrependToolResultsToUserMessage = (message: Extract<MessagesMessage, { role: 'user' }>): boolean =>
  Array.isArray(message.content) && message.content.some(block => block.type === 'tool_result');

interface PreparedMessagesWebSearchReplay {
  hasOwnedReplay: boolean;
  messages: MessagesMessage[];
  priorSearchUseCount: number;
  requestSearchResultOwnership: SearchResultOwnership[];
}

const prepareMessagesWebSearchReplay = (messages: MessagesMessage[]): PreparedMessagesWebSearchReplay => {
  const hasOwnedReplay = messages.some(messageHasOwnedReplayMarkers);
  const rewrittenMessages: MessagesMessage[] = [];
  const requestSearchResultOwnership: SearchResultOwnership[] = [];
  let pendingOwnedReplayToolResults: OwnedReplayToolResult[] = [];
  let priorSearchUseCount = 0;

  const flushPendingOwnedReplayToolResults = () => {
    if (pendingOwnedReplayToolResults.length === 0) {
      return;
    }

    rewrittenMessages.push(buildUserToolResultMessage(pendingOwnedReplayToolResults.map(({ upstreamToolResult }) => upstreamToolResult)));
    requestSearchResultOwnership.push(...pendingOwnedReplayToolResults.flatMap(({ searchResultOwnership }) => searchResultOwnership));
    pendingOwnedReplayToolResults = [];
  };

  for (const message of messages) {
    if (pendingOwnedReplayToolResults.length > 0 && message.role !== 'user') {
      flushPendingOwnedReplayToolResults();
    }

    if (message.role === 'user') {
      const foreignSearchResultOwnership = collectForeignSearchResultOwnership(message.content);

      if (pendingOwnedReplayToolResults.length > 0 && canPrependToolResultsToUserMessage(message)) {
        rewrittenMessages.push(
          prependToolResultsToUserMessage(
            message,
            pendingOwnedReplayToolResults.map(({ upstreamToolResult }) => upstreamToolResult),
          ),
        );
        requestSearchResultOwnership.push(...pendingOwnedReplayToolResults.flatMap(({ searchResultOwnership }) => searchResultOwnership), ...foreignSearchResultOwnership);
        pendingOwnedReplayToolResults = [];
        continue;
      }

      flushPendingOwnedReplayToolResults();
      rewrittenMessages.push(message);
      requestSearchResultOwnership.push(...foreignSearchResultOwnership);
      continue;
    }

    if (!Array.isArray(message.content)) {
      rewrittenMessages.push(message);
      continue;
    }

    const ownedReplayResultsByServerToolUseId = collectOwnedReplayResultsByServerToolUseId(message.content);

    for (const ownedReplayResult of ownedReplayResultsByServerToolUseId.values()) {
      priorSearchUseCount += 1;
      pendingOwnedReplayToolResults.push(ownedReplayResult);
    }

    const rewrittenContent = message.content.flatMap((block): MessagesAssistantContentBlock[] => {
      if (block.type === 'server_tool_use' && ownedReplayResultsByServerToolUseId.has(block.id)) {
        return [
          {
            type: 'tool_use',
            id: toUpstreamToolUseId(block.id),
            name: block.name,
            input: block.input,
          },
        ];
      }

      if (block.type === 'web_search_tool_result' && ownedReplayResultsByServerToolUseId.has(block.tool_use_id)) {
        return [];
      }

      if (block.type !== 'text' || !block.citations) {
        return [block];
      }

      return [mapTextBlockCitations(block, decodeOwnedReplayCitation)];
    });

    rewrittenMessages.push({
      role: 'assistant',
      content: rewrittenContent,
    });
  }

  flushPendingOwnedReplayToolResults();

  return {
    hasOwnedReplay,
    messages: rewrittenMessages,
    priorSearchUseCount,
    requestSearchResultOwnership,
  };
};

type ValidateNativeWebSearchToolDefinitionsResult = { type: 'ok'; nativeTool?: MessagesNativeWebSearchTool } | { type: 'invalid-request'; message: string };

const validateNativeWebSearchToolDefinitions = (payload: MessagesPayload): ValidateNativeWebSearchToolDefinitionsResult => {
  const nativeToolEntries = (payload.tools ?? []).flatMap((tool, index) => (isNativeWebSearchToolDefinition(tool) ? [{ tool, index }] : []));

  if (nativeToolEntries.length > 1) {
    return {
      type: 'invalid-request',
      message: 'Only one native web search tool definition is supported per request.',
    };
  }

  const nativeTool = nativeToolEntries[0]?.tool;
  if (nativeTool?.name !== undefined && nativeTool.name !== WEB_SEARCH_TOOL_NAME) {
    return {
      type: 'invalid-request',
      message: `tools.${nativeToolEntries[0].index}.${nativeTool.type}.name: Input should be '${WEB_SEARCH_TOOL_NAME}'`,
    };
  }

  if (nativeTool && (payload.tools ?? []).some(tool => !isNativeWebSearchToolDefinition(tool) && tool.name === WEB_SEARCH_TOOL_NAME)) {
    return {
      type: 'invalid-request',
      message: `Native web search tool name collides with another client tool: ${WEB_SEARCH_TOOL_NAME}.`,
    };
  }

  return {
    type: 'ok',
    nativeTool,
  };
};

const rewriteMessagesWebSearchToolDefinitions = (tools: MessagesPayload['tools'], nativeTool?: MessagesNativeWebSearchTool): MessagesPayload['tools'] =>
  nativeTool ? (tools ?? []).map(tool => (isNativeWebSearchToolDefinition(tool) ? buildUpstreamWebSearchToolDefinition() : tool)) : tools;

const buildMessagesWebSearchShimState = (nativeTool: MessagesNativeWebSearchTool | undefined, replay: PreparedMessagesWebSearchReplay): MessagesWebSearchShimState => {
  if (!nativeTool && !replay.hasOwnedReplay) {
    return inactiveMessagesWebSearchShimState();
  }

  if (!nativeTool) {
    return {
      mode: 'replay_only',
      priorSearchUseCount: replay.priorSearchUseCount,
      requestSearchResultOwnership: replay.requestSearchResultOwnership,
    };
  }

  return {
    mode: 'active',
    toolVersion: nativeTool.type,
    maxUses: nativeTool.max_uses,
    allowedDomains: normalizeNonEmptyDomainList(nativeTool.allowed_domains),
    blockedDomains: normalizeNonEmptyDomainList(nativeTool.blocked_domains),
    userLocation: nativeTool.user_location
      ? {
          city: nativeTool.user_location.city,
          region: nativeTool.user_location.region,
          country: nativeTool.user_location.country,
          timezone: nativeTool.user_location.timezone,
        }
      : undefined,
    priorSearchUseCount: replay.priorSearchUseCount,
    requestSearchResultOwnership: replay.requestSearchResultOwnership,
  };
};

export const prepareMessagesWebSearchShimRequest = (payload: MessagesPayload): PrepareMessagesWebSearchShimRequestResult => {
  const validatedNativeTools = validateNativeWebSearchToolDefinitions(payload);
  if (validatedNativeTools.type !== 'ok') {
    return validatedNativeTools;
  }

  const replay = prepareMessagesWebSearchReplay(payload.messages);
  const state = buildMessagesWebSearchShimState(validatedNativeTools.nativeTool, replay);

  if (state.mode === 'inactive') {
    return {
      type: 'ok',
      payload,
      state,
    };
  }

  return {
    type: 'ok',
    payload: {
      ...payload,
      ...(payload.tools
        ? {
            tools: rewriteMessagesWebSearchToolDefinitions(payload.tools, validatedNativeTools.nativeTool),
          }
        : {}),
      messages: replay.messages,
    },
    state,
  };
};

const rewriteResponseCitationToNative = (citation: MessagesTextCitation, state: MessagesWebSearchShimState): MessagesTextCitation => {
  if (state.mode === 'inactive' || citation.type !== 'search_result_location') {
    return citation;
  }

  if (state.requestSearchResultOwnership[citation.search_result_index] !== 'owned') {
    return citation;
  }

  return {
    type: 'web_search_result_location',
    url: citation.url,
    title: citation.title,
    encrypted_index: encodeWebSearchCitationPayload({
      search_result_index: citation.search_result_index,
      start_block_index: citation.start_block_index,
      end_block_index: citation.end_block_index,
    }),
    ...(citation.cited_text ? { cited_text: citation.cited_text } : {}),
  };
};

const normalizeWebSearchQuery = (input: Record<string, unknown>): string | null => (typeof input.query === 'string' ? input.query.trim() : null);

const buildNativeWebSearchResultBlockFromProviderResult = (result: WebSearchProviderResult, toolUseId: string): Extract<MessagesAssistantContentBlock, { type: 'web_search_tool_result' }> => {
  if (result.type === 'error') {
    return buildNativeWebSearchErrorResultBlock(toolUseId, result.errorCode);
  }

  return {
    type: 'web_search_tool_result',
    tool_use_id: toNativeServerToolUseId(toolUseId),
    content: result.results.map(buildNativeWebSearchResultBlock),
    caller: { type: 'direct' },
  };
};

const searchWithActiveMessagesWebSearchProvider = (provider: ActiveMessagesWebSearchProvider, request: WebSearchProviderRequest): Promise<WebSearchProviderResult> =>
  provider.apiKeyId
    ? searchWebAndRecordUsage({
        provider: provider.search,
        providerName: provider.providerName,
        keyId: provider.apiKeyId,
        request,
      })
    : searchWebWithoutRecordingUsage({
        provider: provider.search,
        request,
      });

export const rewriteMessagesWebSearchResponseToNative = async (
  response: MessagesResponse,
  state: MessagesWebSearchShimState,
  provider?: ActiveMessagesWebSearchProvider,
): Promise<MessagesResponse> => {
  if (state.mode === 'inactive') {
    return response;
  }

  if (state.mode === 'active' && !provider) {
    throw new Error('Active messages web-search rewrite requires a provider.');
  }

  let executedSearchCount = 0;
  let interceptedSearches = 0;
  let hasRemainingClientToolUse = false;
  let currentSearchUseCount = state.priorSearchUseCount;
  const rewrittenContent: MessagesAssistantContentBlock[] = [];

  for (const block of response.content) {
    if (block.type === 'text') {
      rewrittenContent.push(mapTextBlockCitations(block, citation => rewriteResponseCitationToNative(citation, state)));
      continue;
    }

    if (state.mode !== 'active' || block.type !== 'tool_use' || block.name !== WEB_SEARCH_TOOL_NAME) {
      if (block.type === 'tool_use') {
        hasRemainingClientToolUse = true;
      }
      rewrittenContent.push(block);
      continue;
    }

    interceptedSearches += 1;
    const query = normalizeWebSearchQuery(block.input);
    rewrittenContent.push(buildNativeWebSearchServerToolUseBlock(block.id, query ?? ''));

    if (state.maxUses !== undefined && currentSearchUseCount >= state.maxUses) {
      rewrittenContent.push(buildNativeWebSearchErrorResultBlock(block.id, 'max_uses_exceeded'));
      continue;
    }

    if (!query || query.length === 0) {
      rewrittenContent.push(buildNativeWebSearchErrorResultBlock(block.id, 'invalid_tool_input'));
      continue;
    }

    if (query.length > MAX_QUERY_LENGTH) {
      rewrittenContent.push(buildNativeWebSearchErrorResultBlock(block.id, 'query_too_long'));
      continue;
    }

    executedSearchCount += 1;
    currentSearchUseCount += 1;

    try {
      const providerResult = await searchWithActiveMessagesWebSearchProvider(provider!, {
        query,
        allowedDomains: state.allowedDomains,
        blockedDomains: state.blockedDomains,
        userLocation: state.userLocation,
      });

      rewrittenContent.push(buildNativeWebSearchResultBlockFromProviderResult(providerResult, block.id));
    } catch {
      // TODO: Add gateway-side recent web-search error-log storage so operators can inspect detailed provider/runtime failures even though the client-visible native error intentionally collapses them to `unavailable`.
      rewrittenContent.push(buildNativeWebSearchErrorResultBlock(block.id, 'unavailable'));
    }
  }

  return {
    ...response,
    content: rewrittenContent,
    stop_reason: interceptedSearches === 0 ? response.stop_reason : hasRemainingClientToolUse ? 'tool_use' : 'pause_turn',
    usage:
      executedSearchCount > 0
        ? {
            ...response.usage,
            server_tool_use: {
              web_search_requests: executedSearchCount,
            },
          }
        : response.usage,
  };
};

export const collectAndRewriteMessagesWebSearchEventsToNative = async function* (
  frames: AsyncIterable<ProtocolFrame<MessagesStreamEventData>>,
  state: MessagesWebSearchShimState,
  provider?: ActiveMessagesWebSearchProvider,
): AsyncGenerator<ProtocolFrame<MessagesStreamEventData>> {
  // Native-looking web_search replay is order-sensitive: we may need to
  // execute multiple searches, inject result blocks, and then rewrite later
  // text citations against the final search-result ordering. That forces us
  // to buffer the whole upstream Messages stream here and trade first-byte
  // latency for a single coherent rewritten response.
  const response = await collectMessagesProtocolEventsToResponse(frames);
  const rewritten = await rewriteMessagesWebSearchResponseToNative(response, state, provider);
  yield* messagesResultToEvents(rewritten);
};

const buildSyntheticInvalidRequestUpstreamError = (message: string) => ({
  type: 'upstream-error' as const,
  status: 400,
  headers: new Headers({ 'content-type': 'application/json' }),
  body: new TextEncoder().encode(
    JSON.stringify({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message,
      },
    }),
  ),
});

const resolveActiveMessagesWebSearchProvider = async (apiKeyId: string | undefined): Promise<{ type: 'ok'; provider: ActiveMessagesWebSearchProvider } | ReturnType<typeof internalErrorResult>> => {
  const searchConfig = await loadSearchConfig();
  const configuredProvider = resolveConfiguredWebSearchProvider(searchConfig);

  if (configuredProvider.type === 'enabled') {
    return {
      type: 'ok',
      provider: {
        providerName: configuredProvider.provider,
        search: configuredProvider.search,
        ...(apiKeyId ? { apiKeyId } : {}),
      },
    };
  }

  return internalErrorResult(
    500,
    toInternalDebugError(
      new Error(
        configuredProvider.type === 'disabled'
          ? 'Native Messages web search requires an enabled search provider.'
          : `Native Messages web search is missing the configured ${configuredProvider.provider} credential.`,
      ),
      'messages',
    ),
  );
};

/**
 * Anthropic exposes native `web_search_*` server tools, but non-Messages
 * targets cannot run Anthropic server tools. This shim rewrites the native tool
 * definition into an ordinary client `web_search` tool, executes each search
 * the model issues using the gateway's configured provider, and rewrites the
 * response back to the Anthropic native `server_tool_use` /
 * `web_search_tool_result` / `web_search_result_location` shape.
 *
 * Base Messages routing applies this shim for Messages via non-Messages
 * targets. Providers may also register it for native Messages targets when the
 * upstream should not receive Anthropic native web-search tools directly.
 */
export const withMessagesWebSearchShim: MessagesInterceptor = async (ctx, run) => {
  const prepared = prepareMessagesWebSearchShimRequest(ctx.payload);

  if (prepared.type === 'invalid-request') {
    return buildSyntheticInvalidRequestUpstreamError(prepared.message);
  }

  if (prepared.state.mode === 'inactive') {
    return await run();
  }

  const provider = prepared.state.mode === 'active' ? await resolveActiveMessagesWebSearchProvider(ctx.apiKeyId) : { type: 'ok' as const, provider: undefined };
  if (provider.type !== 'ok') return provider;

  ctx.payload = prepared.payload;

  const result = await run();
  if (result.type !== 'events') return result;

  return {
    ...result,
    events: collectAndRewriteMessagesWebSearchEventsToNative(result.events, prepared.state, provider.provider),
  };
};

export const withMessagesWebSearchShimForTranslatedTargets: MessagesInterceptor = async (ctx, run) => (ctx.targetApi === 'messages' ? await run() : await withMessagesWebSearchShim(ctx, run));
