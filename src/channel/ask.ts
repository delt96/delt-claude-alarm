import { parseQuestionRequest } from '../shared/questions.js';
import type { QuestionRequest } from '../shared/types.js';

export const ASK_LIMITS = { questions: 4, minOptions: 2, maxOptions: 6 } as const;

export const ASK_TOOL = {
  name: 'ask',
  description:
    'Ask the user a question they can answer by picking from a few options. It shows in the dashboard conversation and on Telegram with a button per option (and a box for their own answer unless allowOther is false), and sets your status to waiting_input. It returns at once; keep working on anything that does not depend on the answer. The answer arrives later as a channel message starting with "Answer to your question" or "Answers to your questions". For an open question with no options, use reply instead.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      context: { type: 'string', description: 'Markdown shown above the questions: what you found and why you ask.' },
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: ASK_LIMITS.questions,
        items: {
          type: 'object',
          properties: {
            header: { type: 'string', description: 'Short label for the question, up to 40 characters.' },
            question: { type: 'string', description: 'The question in full (markdown).' },
            options: {
              type: 'array',
              minItems: ASK_LIMITS.minOptions,
              maxItems: ASK_LIMITS.maxOptions,
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', description: 'Button text, which is also the answer you get back.' },
                  description: { type: 'string', description: 'One line under the button explaining the option.' },
                },
                required: ['label'],
              },
            },
            allowOther: { type: 'boolean', description: 'Let the user type an answer of their own (default true).' },
          },
          required: ['question'],
        },
      },
    },
    required: ['questions'],
  },
};

type AskResult = { ok: true; request: QuestionRequest } | { ok: false; error: string };

export function askRequest(args: unknown, sessionId: string, requestId: string, now = Date.now()): AskResult {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  const list = a.questions;
  if (!Array.isArray(list) || list.length < 1 || list.length > ASK_LIMITS.questions) {
    return { ok: false, error: `questions must list 1 to ${ASK_LIMITS.questions} questions` };
  }
  for (const [i, q] of list.entries()) {
    if (!q || typeof q !== 'object') return { ok: false, error: `question ${i + 1} must be an object` };
    const options = (q as { options?: unknown }).options;
    if (options !== undefined && options !== null && (!Array.isArray(options) || options.length < ASK_LIMITS.minOptions || options.length > ASK_LIMITS.maxOptions)) {
      return { ok: false, error: `question ${i + 1} needs ${ASK_LIMITS.minOptions} to ${ASK_LIMITS.maxOptions} options, or none for a free-text answer` };
    }
  }
  return parseQuestionRequest({
    sessionId,
    requestId,
    timestamp: now,
    context: a.context,
    questions: list.map((q, i) => ({ ...(q as object), id: `q${i + 1}` })),
  });
}

export function askResultText(requestId: string, delivery: 'sent' | 'queued'): string {
  const sent = `Question sent (id ${requestId}). It shows in the dashboard conversation and on Telegram with buttons. Keep working on anything that does not depend on the answer; the answer arrives as a channel message starting with "Answer to your question" or "Answers to your questions".`;
  return delivery === 'queued'
    ? `${sent} The hub is not connected right now, so the question is queued and shown once it reconnects. If the answer is urgent, also ask in the terminal.`
    : sent;
}

export const ASK_DROPPED = 'The hub is not connected and its queue is full, so the question was not sent. Ask in the terminal or with reply.';
