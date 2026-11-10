import type * as z from "zod/mini";
import { toError } from "./errors";

type RuntimeMessageListener = Parameters<typeof chrome.runtime.onMessage.addListener>[0];

type RuntimeMessage = Parameters<RuntimeMessageListener>[0];

type SendResponse = Parameters<RuntimeMessageListener>[2];

export type MessageSender = chrome.runtime.MessageSender;

/** The answer when a request is refused, its handler throws, or no context answers. */
export interface ChannelFailure {
  outcome: "failed";
  message: string;
}

export function failChannel(message: string): ChannelFailure {
  return { outcome: "failed", message };
}

/** A request on a channel; its `type` picks the handler and the response. */
interface ChannelRequest {
  type: string;
}

/** The response a channel's `Responses` lists for one request type. */
type ResponseOf<Responses, Type> = Type extends keyof Responses ? Responses[Type] : never;

/** One handler per request type, each answering with that type's response or the failure. */
type ChannelHandlers<Request extends ChannelRequest, Responses, Failure> = {
  [Type in Request["type"]]: (
    request: Extract<Request, { type: Type }>,
    sender: MessageSender,
  ) => Promise<ResponseOf<Responses, Type> | Failure>;
};

export interface Channel<Request extends ChannelRequest, Responses, Failure> {
  schema: z.ZodMiniType<Request>;
  /** Null when the sender may use the channel, otherwise why it may not. */
  refuse(sender: MessageSender): string | null | Promise<string | null>;
  handlers: ChannelHandlers<Request, Responses, Failure>;
  /** The answer when the sender is refused, a handler throws, or nothing answers at all. */
  fail(message: string): Failure;
}

/** Answers a channel's requests and ignores every other message; returns whether it answered. */
export type ChannelListener = (
  message: RuntimeMessage,
  sender: MessageSender,
  sendResponse: SendResponse,
) => boolean;

/** Every parsed request gets an answer: its handler's response, or the channel's failure. */
export function answerChannel<Request extends ChannelRequest, Responses, Failure>(
  channel: Channel<Request, Responses, Failure>,
): ChannelListener {
  return (message, sender, sendResponse) => {
    const parsed = channel.schema.safeParse(message);

    if (!parsed.success) {
      return false;
    }

    void answer(channel, parsed.data, sender).then(sendResponse);

    return true;
  };
}

export function listenOnChannels(...channels: ChannelListener[]): void {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) =>
    channels.some((channel) => channel(message, sender, sendResponse)),
  );
}

async function answer<Request extends ChannelRequest, Responses, Failure>(
  channel: Channel<Request, Responses, Failure>,
  request: Request,
  sender: MessageSender,
): Promise<ResponseOf<Responses, Request["type"]> | Failure> {
  try {
    const refusal = await channel.refuse(sender);

    if (refusal !== null) {
      return channel.fail(refusal);
    }

    const type: Request["type"] = request.type;

    // SAFETY: `handlers` has one entry per request type, and that entry takes requests of its type.
    const handle = channel.handlers[type] as (
      request: Request,
      sender: MessageSender,
    ) => Promise<ResponseOf<Responses, Request["type"]> | Failure>;

    return await handle(request, sender);
  } catch (error) {
    return channel.fail(toError(error).message);
  }
}

/**
 * Sends a request to the other extension contexts. A context that is gone, or that does not
 * answer, yields the channel's failure rather than a rejection or `undefined`.
 */
export async function sendChannelRequest<Response, Failure>(
  request: ChannelRequest,
  fail: (message: string) => Failure,
): Promise<Response | Failure> {
  try {
    const response = await chrome.runtime.sendMessage<ChannelRequest, Response | undefined>(
      request,
    );

    return response ?? fail("No Gather Box context answered the request.");
  } catch (error) {
    return fail(toError(error).message);
  }
}

/** Extension pages (the side panel, the offscreen document) rather than a content script. */
export function isExtensionPageSender(sender: MessageSender): boolean {
  return !sender.tab && sender.id === chrome.runtime.id;
}
