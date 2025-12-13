interface Env {
  AI: any;
  AGENT_STATE: DurableObjectNamespace;
  ASSETS: any;
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

interface ChatRequest {
  message: string;
  replaceHistory?: { role: 'user' | 'assistant'; content: string }[];
}

interface ClearRequest {
  conversationId?: string;
}

interface ChatResponse {
  response: string;
  conversationId: string;
}

interface HistoryResponse {
  history: ChatMessage[];
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    console.log(`[Worker] ${request.method} ${url.pathname}`);

    if (request.method === 'OPTIONS') {
      console.log('[Worker] Handling CORS preflight');
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    if (url.pathname === '/chat' && request.method === 'POST') {
      console.log('[Worker] Chat request received');
      const { message, replaceHistory } = await request.json<ChatRequest>();
      const conversationId = url.searchParams.get('conversation') || 'default';
      console.log(`[Worker] Conversation ID: ${conversationId}`);
      if (replaceHistory) {
        console.log(`[Worker] replaceHistory provided with ${replaceHistory.length} messages`);
      }

      const id = env.AGENT_STATE.idFromName(conversationId);
      const stub = env.AGENT_STATE.get(id);

      console.log('[Worker] Calling Durable Object...');
      const startTime = Date.now();

      const response = await stub.fetch('http://internal/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, replaceHistory }),
      });

      const endTime = Date.now();
      console.log(`[Worker] Durable Object call took ${endTime - startTime}ms`);

      const result = await response.json();
      console.log(`[Worker] Response status: ${response.status}`);

      return new Response(JSON.stringify(result), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    if (url.pathname === '/history' && request.method === 'GET') {
      console.log('[Worker] History request received');
      const conversationId = url.searchParams.get('conversation') || 'default';
      const id = env.AGENT_STATE.idFromName(conversationId);
      const stub = env.AGENT_STATE.get(id);

      const response = await stub.fetch('http://internal/history', {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });

      return new Response(JSON.stringify(await response.json()), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    if (url.pathname === '/clear' && request.method === 'POST') {
      console.log('[Worker] Clear request received');
      const { conversationId } = await request.json<ClearRequest>();
      const id = env.AGENT_STATE.idFromName(conversationId || 'default');
      const stub = env.AGENT_STATE.get(id);

      const response = await stub.fetch('http://internal/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      return new Response(JSON.stringify(await response.json()), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    console.log('[Worker] Serving static assets');
    return env.ASSETS.fetch(request);
  },
};

export class AgentState {
  state: DurableObjectState;
  env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    console.log(`[DurableObject] Request: ${request.method} ${url.pathname}`);

    if (request.method === 'GET' && url.pathname === '/history') {
      console.log('[DurableObject] Fetching conversation history');
      const history: ChatMessage[] = (await this.state.storage.get('conversationHistory')) || [];
      console.log(`[DurableObject] History length: ${history.length}`);
      return new Response(JSON.stringify({ history } as HistoryResponse));
    }

    if (request.method === 'POST' && url.pathname === '/clear') {
      console.log('[DurableObject] Clearing conversation history');
      await this.state.storage.delete('conversationHistory');
      return new Response(JSON.stringify({ success: true }));
    }

    if (request.method === 'POST' && url.pathname === '/chat') {
      console.log('[DurableObject] Processing chat request');
      const { message, replaceHistory } = await request.json<ChatRequest>();
      console.log(`[DurableObject] User message: ${message.substring(0, 100)}${message.length > 100 ? '...' : ''}`);

      let history: ChatMessage[];

      if (replaceHistory) {
        console.log(`[DurableObject] Replacing history with ${replaceHistory.length} messages`);
        history = replaceHistory.map(m => ({ role: m.role, content: m.content, timestamp: Date.now() }));
      } else {
        history = (await this.state.storage.get('conversationHistory')) || [];
        console.log(`[DurableObject] Current history length: ${history.length}`);
      }

      history.push({ role: 'user', content: message, timestamp: Date.now() });

      const systemPrompt = `You are a highly intelligent AI assistant with expertise in various fields. You provide clear, helpful, and engaging responses. You can assist with coding, research, creative tasks, and general inquiries. Always be truthful and direct.`;

      const messages = [
        { role: 'system', content: systemPrompt },
        ...history.slice(-15).map(h => ({ role: h.role, content: h.content }))
      ];

      console.log(`[DurableObject] Sending ${messages.length} messages to AI`);
      console.log(`[DurableObject] Message roles: ${messages.map(m => m.role).join(', ')}`);
      const totalTokens = messages.reduce((sum, m) => sum + m.content.split(' ').length, 0);
      console.log(`[DurableObject] Estimated token count: ${totalTokens}`);

      try {
        console.log('[DurableObject] Calling AI API...');
        const startTime = Date.now();

        const response = await this.env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
          messages,
          temperature: 0.8,
          max_tokens: 1000,
        });

        const endTime = Date.now();
        console.log(`[DurableObject] AI API call took ${endTime - startTime}ms`);

        const aiResponse = response.response || 'I apologize, but I couldn\'t generate a response right now.';
        console.log(`[DurableObject] AI response length: ${aiResponse.length}`);

        history.push({ role: 'assistant', content: aiResponse, timestamp: Date.now() });
        await this.state.storage.put('conversationHistory', history);
        console.log(`[DurableObject] Saved history with ${history.length} messages`);

        return new Response(JSON.stringify({
          response: aiResponse,
          conversationId: this.state.id.toString()
        } as ChatResponse));

      } catch (error: any) {
        console.error('[DurableObject] AI Error:', error);
        console.error('[DurableObject] Error type:', error.constructor.name);
        console.error('[DurableObject] Error stack:', error.stack);
        console.error('[DurableObject] Error message:', error.message);

        let errorMessage = 'Sorry, I encountered an error processing your request.';

        if (error.message?.includes('5007')) {
          errorMessage = 'AI model not available. This might be due to usage limits or model access restrictions.';
        } else if (error.message?.includes('rate limit') || error.message?.includes('429')) {
          errorMessage = 'Rate limit exceeded. Please wait a moment before trying again.';
        } else if (error.message?.includes('usage') || error.message?.includes('quota')) {
          errorMessage = 'Usage limit reached. Please check your Cloudflare Workers AI plan.';
        }

        return new Response(JSON.stringify({
          response: errorMessage,
          error: error.message
        }), { status: 503 });
      }
    }

    console.log(`[DurableObject] Invalid request: ${request.method} ${url.pathname}`);
    return new Response(JSON.stringify({ error: 'Invalid request' }), { status: 400 });
  }
}
