// Responses API type definitions
// Used for translating Messages ↔ Responses APIs

// ── Request types ──

export interface ResponsesPayload {
  model: string;
  input: string | ResponseInputItem[];
  previous_response_id?: string | null;
  instructions?: string | null;
  temperature?: number | null;
  top_p?: number | null;
  max_output_tokens?: number | null;
  tools?: ResponseTool[] | null;
  tool_choice?: ResponseToolChoice;
  metadata?: Record<string, unknown> | null;
  stream?: boolean | null;
  store?: boolean | null;
  parallel_tool_calls?: boolean | null;
  reasoning?: {
    effort?: string;
    summary?: "detailed" | "auto" | "concise";
  };
  include?: string[];
  text?: { format?: Record<string, unknown> | null } | null;
  prompt_cache_key?: string | null;
  safety_identifier?: string | null;
  service_tier?: string | null;
}

export type ResponseInputItem =
  | ResponseInputMessage
  | ResponseFunctionToolCallItem
  | ResponseFunctionCallOutputItem
  | ResponseInputReasoning
  | ResponseItemReference;

export interface ResponseInputMessage {
  type: "message";
  role: "user" | "assistant" | "system" | "developer";
  content: string | ResponseInputContent[];
}

export type ResponseInputContent =
  | ResponseInputText
  | ResponseInputImage;

export interface ResponseInputText {
  type: "input_text" | "output_text";
  text: string;
}

export interface ResponseInputImage {
  type: "input_image";
  image_url: string;
  detail: "auto" | "low" | "high";
}

export interface ResponseInputReasoning {
  type: "reasoning";
  id: string;
  summary: { type: "summary_text"; text: string }[];
  encrypted_content?: string;
}

interface ResponseFunctionToolCallItem {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
  status: "completed" | "in_progress" | "incomplete";
}

interface ResponseFunctionCallOutputItem {
  type: "function_call_output";
  call_id: string;
  output: string;
  status?: "completed" | "incomplete";
}

export interface ResponseItemReference {
  type: "item_reference";
  id: string;
}

export interface ResponseFunctionTool {
  type: "function";
  name: string;
  parameters: Record<string, unknown>;
  strict: boolean;
  description?: string;
}

// Codex and other Responses clients ship hosted server tools (web_search,
// image_generation, tool_search, namespace) and Freeform `custom` tools
// alongside ordinary function tools. The gateway does not host any of those,
// so source-level interceptors normalize them into function tools or strip
// them before planning. The wire-level tools array is still a heterogeneous
// union and translators must narrow on `type === "function"` before reading
// `name` / `parameters`.
export interface ResponseHostedTool {
  type: "web_search" | "image_generation" | "tool_search" | "namespace";
  [key: string]: unknown;
}

export interface ResponseCustomTool {
  type: "custom";
  name: string;
  description?: string;
  format?: Record<string, unknown>;
}

export type ResponseTool =
  | ResponseFunctionTool
  | ResponseHostedTool
  | ResponseCustomTool;

export type ResponseToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; name: string }
  | { type: "custom"; name: string }
  | { type: "web_search" | "image_generation" | "tool_search" | "namespace" };

// ── Response types ──

export interface ResponsesResult {
  id: string;
  object: string;
  model: string;
  output: ResponseOutputItem[];
  output_text: string;
  status: "completed" | "incomplete" | "failed" | "in_progress";
  incomplete_details?: { reason: string };
  error?: { message: string; type: string; code: string };
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    input_tokens_details?: { cached_tokens: number };
    output_tokens_details?: { reasoning_tokens: number };
  };
}

export type ResponseOutputItem =
  | ResponseOutputMessage
  | ResponseOutputFunctionCall
  | ResponseOutputReasoning;

export interface ResponseOutputMessage {
  type: "message";
  role: "assistant";
  content: ResponseOutputContentBlock[];
}

export type ResponseOutputContentBlock =
  | ResponseOutputText
  | ResponseOutputRefusal;

interface ResponseOutputText {
  type: "output_text";
  text: string;
}

interface ResponseOutputRefusal {
  type: "refusal";
  refusal: string;
}

export interface ResponseOutputFunctionCall {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
  status: string;
}

export interface ResponseOutputReasoning {
  type: "reasoning";
  id: string;
  summary: { type: "summary_text"; text: string }[];
  encrypted_content?: string;
}

// ── Stream event types ──

export type ResponseStreamEvent =
  | { type: "response.created"; response: ResponsesResult }
  | { type: "response.in_progress"; response: ResponsesResult }
  | {
    type: "response.output_item.added";
    output_index: number;
    item: ResponseOutputItem;
  }
  | {
    type: "response.output_item.done";
    output_index: number;
    item: ResponseOutputItem;
  }
  | {
    type: "response.content_part.added";
    item_id: string;
    output_index: number;
    content_index: number;
    part: ResponseOutputContentBlock;
  }
  | {
    type: "response.content_part.done";
    item_id: string;
    output_index: number;
    content_index: number;
    part: ResponseOutputContentBlock;
  }
  | {
    type: "response.reasoning_summary_part.added";
    item_id: string;
    output_index: number;
    summary_index: number;
    part: { type: "summary_text"; text: string };
  }
  | {
    type: "response.reasoning_summary_part.done";
    item_id: string;
    output_index: number;
    summary_index: number;
    part: { type: "summary_text"; text: string };
  }
  | {
    type: "response.reasoning_summary_text.delta";
    item_id: string;
    output_index: number;
    summary_index: number;
    delta: string;
  }
  | {
    type: "response.reasoning_summary_text.done";
    item_id: string;
    output_index: number;
    summary_index: number;
    text: string;
  }
  | {
    type: "response.output_text.delta";
    item_id: string;
    output_index: number;
    content_index: number;
    delta: string;
  }
  | {
    type: "response.output_text.done";
    item_id: string;
    output_index: number;
    content_index: number;
    text: string;
  }
  | {
    type: "response.function_call_arguments.delta";
    item_id: string;
    output_index: number;
    delta: string;
  }
  | {
    type: "response.function_call_arguments.done";
    item_id: string;
    output_index: number;
    arguments: string;
  }
  | { type: "response.completed"; response: ResponsesResult }
  | { type: "response.incomplete"; response: ResponsesResult }
  | { type: "response.failed"; response: ResponsesResult }
  | {
    type: "error";
    message: string;
    code?: string;
    name?: string;
    stack?: string;
    cause?: unknown;
    source_api?: string;
    target_api?: string;
  }
  | { type: "ping" }
  | { type: string; [key: string]: unknown };
