import type { Context } from "@netlify/functions";
import { getDeployStore } from "@netlify/blobs";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

function createSessionCookie(context: Context, sessionId: string) {
  context.cookies.set({
    name: "session_id",
    value: sessionId,
    path: "/",
    secure: true,
    sameSite: "Strict",
    expires: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
  });
}

async function handleNewConversation(context: Context, store: ReturnType<typeof getDeployStore>) {
  const oldSessionId = context.cookies.get("session_id");
  if (oldSessionId) {
    await store.delete(`${oldSessionId}`);
  }
  
  const sessionId = crypto.randomUUID();
  createSessionCookie(context, sessionId);
  return new Response(JSON.stringify({ success: true }));
}

async function createChatCompletion(messages: ChatMessage[]) {
  return await openai.chat.completions.create({
    model: "gpt-3.5-turbo",
    messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
    stream: true,
  });
}

function createStreamResponse(stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>, updatedHistory: ChatMessage[], sessionId: string, store: ReturnType<typeof getDeployStore>) {
  let assistantMessage = "";
  
  const readableStream = new ReadableStream({
    async start(controller) {
      for await (const chunk of stream) {
        const text = chunk.choices[0]?.delta?.content || "";
        if (text) {
          assistantMessage += text;
          controller.enqueue(new TextEncoder().encode(text));
        }
      }
      // Save the complete conversation after assistant's response
      await store.setJSON(`${sessionId}`, [...updatedHistory, { 
        role: "assistant", 
        content: assistantMessage 
      }]);
      controller.close();
    },
  });

  return new Response(readableStream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

export default async function(req: Request, context: Context) {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    const text = await req.text();
    const body = JSON.parse(text || "{}");
    const store = getDeployStore("chat-history");

    if (body.newConversation) {
      return handleNewConversation(context, store);
    }

    let sessionId = context.cookies.get("session_id");
    if (!sessionId) {
      sessionId = crypto.randomUUID();
      createSessionCookie(context, sessionId);
    }

    const { message } = body;
    if (!message) {
      return new Response("Message is required", { status: 400 });
    }

    // Get existing conversation or start new one
    const history = (await store.get(`${sessionId}`, { type: "json" }) || []) as ChatMessage[];
    const updatedHistory = [...history, { role: "user" as const, content: message }];
    
    const stream = await createChatCompletion(updatedHistory);
    return createStreamResponse(stream, updatedHistory, sessionId, store);

  } catch (error) {
    console.error("Error:", error);
    return new Response(JSON.stringify({ error: "Internal Server Error" }), {
      status: 500,
    });
  }
}