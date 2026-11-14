import { Logger } from '@nestjs/common';
import type { ClsService } from 'nestjs-cls';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { SpanStatusCode } from '@opentelemetry/api';
import type { LiftRecord } from '@lifting-logbook/core';
import { IMPORT_SUGGESTION_HOURLY_LIMIT } from '@lifting-logbook/types';
import { RlsContextService } from '../adapters/prisma/rls-context.service';
import type { PrismaService } from '../adapters/prisma/prisma.service';
import type {
  IImportSuggestionProvider,
  ImportSuggestionCall,
  ImportSuggestionCallResult,
} from '../ports/IImportSuggestionProvider';
import { IMPORT_DATE, PROGRAMS, rowsOf, fiveThreeOne, segment, twoRuns, ymdOf } from '../testing/import-suggestion-fixtures';
import { InMemoryImportSuggestionUsage, PrismaImportSuggestionUsage } from './import-suggestion-usage';
import { ImportSuggestionsService, SUGGESTION_DEADLINE_MS, type SuggestionSource } from './import-suggestions.service';
import * as validation from './suggestion-validation';

const exporter = new InMemorySpanExporter();
new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }).register();

const NOTE = 'left knee sore after the walk';
const CUSTOM_LIFT = 'Zercher Hold';
const REASON = 'the weights reset here so a new run started';

/** A provider that records what it was sent and answers with whatever the test gives it. */
class FakeProvider implements IImportSuggestionProvider {
  readonly label = 'Fake model at test';
  readonly kind = 'fake';
  readonly calls: ImportSuggestionCall[] = [];
  /** Open transactions when the call arrived. */
  readonly openAtCall: number[] = [];
  constructor(
    private readonly answer: (call: ImportSuggestionCall, signal: AbortSignal) => Promise<ImportSuggestionCallResult>,
    private readonly prisma?: FakePrisma,
  ) {}
  suggest(call: ImportSuggestionCall, signal: AbortSignal) {
    this.calls.push(call);
    this.openAtCall.push(this.prisma?.open ?? 0);
    return this.answer(call, signal);
  }
}

const answering = (output: unknown, truncated = false) => async (): Promise<ImportSuggestionCallResult> => ({
  output,
  inputTokens: 1_234,
  outputTokens: 56,
  truncated,
});

/** Never answers; rejects once its signal aborts, as the SDKs do. */
const hanging = () => (_call: ImportSuggestionCall, signal: AbortSignal) =>
  new Promise<ImportSuggestionCallResult>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('Request was aborted.'), { name: 'APIUserAbortError' })));
  });

/** Counts open transactions; its transaction client answers the usage table's queries. */
class FakePrisma {
  open = 0;
  transactions = 0;
  usage: Array<{ userId: string; usedAt: Date }> = [];
  async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    this.open++;
    this.transactions++;
    try {
      return await fn(this.tx);
    } finally {
      this.open--;
    }
  }
  private readonly tx = {
    $executeRaw: async () => 0,
    importSuggestionUsage: {
      deleteMany: async ({ where }: { where: { userId: string; usedAt: { lte: Date } } }) => {
        this.usage = this.usage.filter((u) => u.userId !== where.userId || u.usedAt > where.usedAt.lte);
      },
      findMany: async ({ where }: { where: { userId: string; usedAt: { gt: Date } } }) =>
        this.usage.filter((u) => u.userId === where.userId && u.usedAt > where.usedAt.gt).sort((a, b) => +a.usedAt - +b.usedAt),
      create: async ({ data }: { data: { userId: string; usedAt: Date } }) => {
        this.usage.push(data);
      },
    },
  };
}

const cls = { get: () => 'user-1', set: () => undefined } as unknown as ClsService;

function source(rows: LiftRecord[] = twoRuns({ notes: NOTE })): SuggestionSource {
  return {
    segmented: segment(rows),
    importDate: IMPORT_DATE,
    programs: PROGRAMS,
    exported: false,
    liftNames: new Map([['zercher-hold', CUSTOM_LIFT]]),
  };
}

function serviceWith(provider: FakeProvider | null, prisma?: FakePrisma) {
  const rls = new RlsContextService(cls, (prisma ?? null) as unknown as PrismaService | null);
  const usage = prisma
    ? new PrismaImportSuggestionUsage(prisma as unknown as ConstructorParameters<typeof PrismaImportSuggestionUsage>[0])
    : new InMemoryImportSuggestionUsage();
  return new ImportSuggestionsService(provider, usage, rls);
}

let logged: unknown[][];
beforeEach(() => {
  exporter.reset();
  logged = [];
  for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
      logged.push([level, ...args]);
    });
  }
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

const loggedText = () => JSON.stringify(logged);

describe('ImportSuggestionsService (#1174)', () => {
  it('returns off and calls nothing when no provider is set', async () => {
    const load = jest.fn(async () => source());
    const result = await serviceWith(null).suggest({ userId: 'user-1', notes: false, load });
    expect(result).toEqual({ status: 'off' });
    expect(load).not.toHaveBeenCalled();
  });

  it('sends the payload with no transaction open, and returns validated suggestions', async () => {
    const prisma = new FakePrisma();
    const provider = new FakeProvider(
      answering({ suggestions: [{ kind: 'boundary', action: 'add', date: ymdOf(8), reason: REASON }] }),
      prisma,
    );
    const service = serviceWith(provider, prisma);

    const result = await service.suggest({ userId: 'user-1', notes: false, load: async () => source() });

    expect(provider.calls).toHaveLength(1);
    // The load and the hourly count each ran in a transaction of their own, both closed by the call.
    expect(prisma.transactions).toBe(2);
    expect(provider.openAtCall).toEqual([0]);
    expect(result).toEqual({
      status: 'ready',
      provider: 'Fake model at test',
      notesSent: false,
      summarizedSessions: 0,
      suggestions: [{ kind: 'boundary', action: 'add', date: ymdOf(8), reason: REASON }],
      dropped: { malformed: 0, 'unknown-lift': 0, 'out-of-range': 0 },
    });
    expect(provider.calls[0]?.maxOutputTokens).toBe(2_000);
    expect(JSON.stringify(provider.calls[0]?.payload)).not.toContain(NOTE);
  });

  it('sends notes only when the lifter opts in', async () => {
    const provider = new FakeProvider(answering({ suggestions: [] }));
    await serviceWith(provider).suggest({ userId: 'user-1', notes: true, load: async () => source() });
    expect(JSON.stringify(provider.calls[0]?.payload)).toContain(NOTE);
  });

  describe('a bad answer leaves the rules’ grouping unchanged', () => {
    it.each([
      ['malformed', 'not json at all', { malformed: 1, 'unknown-lift': 0, 'out-of-range': 0 }],
      [
        'malformed items',
        { suggestions: [{ kind: 'boundary' }, 42, { kind: 'note', text: 'ok' }] },
        { malformed: 2, 'unknown-lift': 0, 'out-of-range': 0 },
      ],
      [
        'unknown-lift',
        { suggestions: [{ kind: 'note', text: 'x', lifts: ['Front Squat'] }, { kind: 'note', text: 'x', lifts: ['Snatch'] }] },
        { malformed: 0, 'unknown-lift': 2, 'out-of-range': 0 },
      ],
      [
        'out-of-range',
        {
          suggestions: [
            { kind: 'boundary', action: 'add', date: '2025-01-01', reason: 'x' },
            { kind: 'status', stretchStart: ymdOf(44), status: 'abandoned', reason: 'x' },
            { kind: 'program', stretchStart: ymdOf(0), program: 'nonexistent', reason: 'x' },
          ],
        },
        { malformed: 0, 'unknown-lift': 0, 'out-of-range': 3 },
      ],
    ])('%s', async (_label, output, dropped) => {
      const src = source();
      const before = structuredClone(src.segmented);
      const service = serviceWith(new FakeProvider(answering(output)));

      const result = await service.suggest({ userId: 'user-1', notes: false, load: async () => src });

      expect(src.segmented).toEqual(before);
      expect(result).toMatchObject({ status: 'ready', dropped });
      expect(result.status === 'ready' && result.suggestions.length).toBe(
        output === 'not json at all' ? 0 : (output as { suggestions: unknown[] }).suggestions.length - Object.values(dropped).reduce((a, b) => a + b, 0),
      );
    });

    it('timed out', async () => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
      const src = source();
      const before = structuredClone(src.segmented);
      const service = serviceWith(new FakeProvider(hanging()));

      const pending = service.suggest({ userId: 'user-1', notes: false, load: async () => src });
      await jest.advanceTimersByTimeAsync(SUGGESTION_DEADLINE_MS);

      await expect(pending).resolves.toEqual({ status: 'unavailable', reason: 'timeout' });
      expect(src.segmented).toEqual(before);
      expect(logged).toContainEqual(['warn', expect.objectContaining({ outcome: 'timeout' }), expect.any(String)]);
    });
  });

  it('returns an error, not a throw, when the provider fails', async () => {
    const provider = new FakeProvider(async () => {
      throw Object.assign(new Error(`upstream said: ${NOTE}`), { name: 'APIError', status: 529 });
    });
    const result = await serviceWith(provider).suggest({ userId: 'user-1', notes: true, load: async () => source() });

    expect(result).toEqual({ status: 'unavailable', reason: 'error' });
    expect(logged).toContainEqual([
      'warn',
      expect.objectContaining({
        provider: 'fake',
        outcome: 'error',
        error: 'APIError (HTTP 529)',
        sessions: 14,
        stretches: 2,
        setsSent: 84,
        notesSent: true,
        providerMs: expect.any(Number),
        durationMs: expect.any(Number),
      }),
      expect.any(String),
    ]);
    expect(loggedText()).not.toContain(NOTE);
    const [span] = exporter.getFinishedSpans();
    expect(span?.status).toEqual({ code: SpanStatusCode.ERROR, message: 'APIError (HTTP 529)' });
  });

  it('aborts the call when the lifter leaves, and logs it as aborted', async () => {
    const provider = new FakeProvider(hanging());
    const left = new AbortController();
    const pending = serviceWith(provider).suggest({ userId: 'user-1', notes: false, load: async () => source(), signal: left.signal });
    await new Promise((resolve) => setImmediate(resolve));
    left.abort();

    await expect(pending).resolves.toEqual({ status: 'unavailable', reason: 'error' });
    // Leaving is ordinary navigation, so it's logged at info, not as a failure.
    expect(logged).toContainEqual(['log', expect.objectContaining({ outcome: 'aborted' }), expect.any(String)]);
    expect(logged.filter(([level]) => level === 'warn')).toEqual([]);
  });

  it('counts nothing and calls nothing when the lifter left before the file was read', async () => {
    const prisma = new FakePrisma();
    const provider = new FakeProvider(answering({ suggestions: [] }), prisma);
    const left = new AbortController();
    const result = await serviceWith(provider, prisma).suggest({
      userId: 'user-1',
      notes: false,
      load: async () => {
        left.abort();
        return source();
      },
      signal: left.signal,
    });

    expect(result).toEqual({ status: 'unavailable', reason: 'error' });
    expect(provider.calls).toHaveLength(0);
    expect(prisma.usage).toHaveLength(0);
    expect(logged).toContainEqual(['log', expect.objectContaining({ outcome: 'aborted' }), expect.any(String)]);
  });

  it('logs an answer cut off at the token limit as truncated', async () => {
    const provider = new FakeProvider(answering('{"suggestions": [{"kind": "no', true));
    const result = await serviceWith(provider).suggest({ userId: 'user-1', notes: false, load: async () => source() });

    expect(result).toMatchObject({ status: 'ready', suggestions: [], dropped: { malformed: 1 } });
    expect(logged).toContainEqual(['log', expect.objectContaining({ outcome: 'ready', truncated: true }), expect.any(String)]);
    const [span] = exporter.getFinishedSpans();
    expect(span?.attributes['import_suggestions.truncated']).toBe(true);
  });

  it('lets an error in validating the answer through, rather than reporting the provider unavailable', async () => {
    const provider = new FakeProvider(answering({ suggestions: [] }));
    const bug = new TypeError('validation bug');
    jest.spyOn(validation, 'validateSuggestions').mockImplementation(() => {
      throw bug;
    });

    await expect(serviceWith(provider).suggest({ userId: 'user-1', notes: false, load: async () => source() })).rejects.toBe(bug);
    expect(logged.filter(([level]) => level === 'warn')).toEqual([]);
  });

  describe('logs and spans', () => {
    it('logs counts, never the payload, a prompt or the response', async () => {
      const rows = rowsOf([...fiveThreeOne(0, 6, { notes: NOTE }), { day: 12, lifts: ['zercher-hold', 'back-squat'], notes: NOTE }]);
      const provider = new FakeProvider(
        answering({ suggestions: [{ kind: 'note', text: `${REASON} for custom-lift-1` }, { kind: 'bogus' }] }),
      );

      const result = await serviceWith(provider).suggest({ userId: 'user-1', notes: true, load: async () => source(rows) });
      expect(result).toMatchObject({ status: 'ready', suggestions: [{ text: `${REASON} for ${CUSTOM_LIFT}` }] });

      const text = loggedText();
      for (const secret of [NOTE, REASON, CUSTOM_LIFT, 'custom-lift-1', 'Back Squat', 'user-1', provider.calls[0]?.system.slice(0, 40) ?? '']) {
        expect(text).not.toContain(secret);
      }
      expect(logged).toContainEqual([
        'log',
        expect.objectContaining({
          provider: 'fake',
          outcome: 'ready',
          sessions: 7,
          stretches: expect.any(Number),
          setsSent: 42,
          summarizedSessions: 0,
          notesSent: true,
          inputTokens: 1_234,
          outputTokens: 56,
          truncated: false,
          suggestions: 1,
          droppedMalformed: 1,
          droppedUnknownLift: 0,
          droppedOutOfRange: 0,
          durationMs: expect.any(Number),
          providerMs: expect.any(Number),
        }),
        expect.any(String),
      ]);
    });

    it('records a span around the provider call with counts only', async () => {
      await serviceWith(new FakeProvider(answering({ suggestions: [] }))).suggest({
        userId: 'user-1',
        notes: false,
        load: async () => source(),
      });

      const spans = exporter.getFinishedSpans().filter((s) => s.name === 'import.suggestions.provider_call');
      expect(spans).toHaveLength(1);
      expect(spans[0]?.attributes).toEqual({
        'import_suggestions.provider': 'fake',
        'import_suggestions.sets_sent': 84,
        'import_suggestions.summarized_sessions': 0,
        'import_suggestions.notes_sent': false,
        'import_suggestions.input_tokens': 1_234,
        'import_suggestions.output_tokens': 56,
        'import_suggestions.truncated': false,
      });
    });
  });

  describe('limits', () => {
    it(`makes no call after ${IMPORT_SUGGESTION_HOURLY_LIMIT} in an hour, and says when to try again`, async () => {
      const prisma = new FakePrisma();
      const provider = new FakeProvider(answering({ suggestions: [] }), prisma);
      const service = serviceWith(provider, prisma);
      const start = new Date('2026-11-14T10:00:00Z');
      for (let i = 0; i < IMPORT_SUGGESTION_HOURLY_LIMIT; i++) {
        const now = new Date(start.getTime() + i * 60_000);
        await expect(service.suggest({ userId: 'user-1', notes: false, load: async () => source(), now })).resolves.toMatchObject({
          status: 'ready',
        });
      }

      const eleventh = await service.suggest({
        userId: 'user-1',
        notes: false,
        load: async () => source(),
        now: new Date(start.getTime() + 30 * 60_000),
      });
      expect(eleventh).toEqual({ status: 'limited', retryAfterMinutes: 30 });
      expect(provider.calls).toHaveLength(IMPORT_SUGGESTION_HOURLY_LIMIT);

      // An hour after the first, one more is allowed: the window slides.
      const later = await service.suggest({
        userId: 'user-1',
        notes: false,
        load: async () => source(),
        now: new Date(start.getTime() + 60 * 60_000),
      });
      expect(later.status).toBe('ready');
      expect(provider.calls).toHaveLength(IMPORT_SUGGESTION_HOURLY_LIMIT + 1);
    });

    it('makes no call and counts nothing for a file over the cap', async () => {
      const prisma = new FakePrisma();
      const provider = new FakeProvider(answering({ suggestions: [] }), prisma);
      const rows = rowsOf(Array.from({ length: 30 }, (_, i) => ({ day: i * 2, lifts: ['front-squat', 'barbell-row'], setsPerLift: 30 })));

      const result = await serviceWith(provider, prisma).suggest({ userId: 'user-1', notes: false, load: async () => source(rows) });

      expect(result).toEqual({ status: 'too-large', sets: 1_800, limit: 1_500 });
      expect(provider.calls).toHaveLength(0);
      expect(prisma.usage).toHaveLength(0);
    });
  });
});
