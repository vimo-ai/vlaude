export interface ContextWindowUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface ContextWindow {
  used_percentage?: number;
  remaining_percentage?: number;
  context_window_size?: number;
  total_input_tokens?: number;
  total_output_tokens?: number;
  current_usage?: ContextWindowUsage;
}

export interface ClaudeStatusJSON {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  model?: {
    id?: string;
    display_name?: string;
  };
  workspace?: {
    current_dir?: string;
    project_dir?: string;
  };
  cost?: {
    total_cost_usd?: number;
    total_duration_ms?: number;
    total_api_duration_ms?: number;
    total_lines_added?: number;
    total_lines_removed?: number;
  };
  context_window?: ContextWindow;
  rate_limits?: {
    five_hour?: {
      used_percentage: number;
      resets_at: number;
    };
    seven_day?: {
      used_percentage: number;
      resets_at: number;
    };
  };
  [key: string]: any;
}

export interface VlaudeStatus {
  connected: boolean;
  mode?: 'local' | 'remote';
}
