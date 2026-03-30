export interface NewsData {
  title: string;
  category: string;
  source: string;
  date: string;
  summary: string;
  keyword: string;
  url: string;
}

export interface GptResponse {
  image?: string;
  result?: NewsData[];
  answer?: string;
}

// Dify RAG + OpenAI Streaming types
export interface DifyRetrievalResource {
  dataset_id: string;
  dataset_name: string;
  document_id: string;
  document_name: string;
  segment_id: string;
  content: string;
  score: number;
  position: number;
}

export type TypingPhase = 'searching' | 'generating';

export interface DifyStreamEvent {
  event: 'message' | 'message_end' | 'message_replace' | 'error' | 'ping' | 'status';
  task_id?: string;
  message_id?: string;
  conversation_id?: string;
  answer?: string;
  created_at?: number;
  metadata?: {
    usage?: Record<string, number>;
    retrieval_resources?: DifyRetrievalResource[];
  };
  code?: string;
  message?: string;
  status?: number | TypingPhase;
}

export interface ChatMessage {
  id: string;
  role: 'ai' | 'user';
  content: string;
  timestamp: string;
  type: 'text' | 'image' | 'news';
  newsItems?: NewsData[];
  imageUrl?: string;
  isStreaming?: boolean;
  sources?: DifyRetrievalResource[];
}
