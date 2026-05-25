// ─── Night Shift by Does News | doesnews.com ───────────────────────────────
// Type definitions for the Night Shift script generator

export interface Env {
  SCRIPTS_BUCKET: R2Bucket;
  OPENAI_API_KEY: string;
  TOMORROW_API_KEY: string;
  NEWSAPI_KEY: string;
  OPENAI_MODEL?: string;   // defaults to "gpt-5.5"
  HOST_NAME?: string;      // defaults to "Penelope Rose"
}

export interface DayForecast {
  date: string;          // "Monday, May 26"
  high: number;          // °F
  low: number;           // °F
  conditions: string;    // "Partly Cloudy"
  precipitationProbability: number; // 0-100 %
  windSpeed: number;     // mph
  windGust: number;      // mph
}

export interface CityForecast {
  city: string;
  state: string;
  tomorrow: DayForecast;
  inTwoDays: DayForecast;
  inThreeDays: DayForecast;
}

export interface WeatherBundle {
  asOf: string;           // ISO timestamp when fetched
  forecasts: CityForecast[];
  fetchErrors: string[];  // cities that failed
}

export interface NightShiftOutput {
  show_title: string;
  episode_date: string;
  estimated_runtime: string;
  elevenlabs_script: string;
  riddle_question: string;
  riddle_answer: string;
  social_copy: {
    episode_summary: string;
    section_posts: { section: string; post: string }[];
  };
  source_notes: string[];
  self_validation: {
    word_count: number;
    estimated_minutes: number;
    within_range: boolean;
  };
  chapters: { title: string }[];
}

// ─── OpenAI Responses API types ─────────────────────────────────────────────

export interface ResponsesAPIRequest {
  model: string;
  instructions?: string;
  input: string | ResponsesAPIMessage[];
  tools?: ResponsesTool[];
  max_output_tokens?: number;
  temperature?: number;
}

export interface ResponsesAPIMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ResponsesTool {
  type: "web_search_preview";
  search_context_size?: "low" | "medium" | "high";
}

export interface ResponsesAPIResponse {
  id: string;
  object: string;
  model: string;
  output: ResponsesOutputItem[];
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
  error?: { message: string; type: string; code: string };
}

export interface ResponsesOutputItem {
  type: "message" | "web_search_call" | "reasoning";
  id?: string;
  role?: string;
  status?: string;
  content?: ResponsesContentItem[];
}

export interface ResponsesContentItem {
  type: "output_text" | "refusal";
  text?: string;
}
