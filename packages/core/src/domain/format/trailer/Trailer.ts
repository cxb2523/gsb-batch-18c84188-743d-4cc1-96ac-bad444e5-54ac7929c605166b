import type { RecordLocation } from './RecordLocation';
import type { TrailerFooter } from './TrailerFooter';

/**
 * How a read recovered from a damaged index record: the records were located by walking
 * backwards from the footer instead, and this is why the index could not be used. Surfaced so
 * callers can show and log that the file needed repairing on the way in.
 */
export interface TrailerFallback {
  /**
   * The failure the index path raised, as it was raised.
   */
  readonly indexError: string;
}

/**
 * What locating the records came to: the record list, plus a note when the index record the
 * last header promised turned out unusable and walking backwards saved the read.
 */
export interface TrailerContents {
  readonly records: readonly RecordLocation[];
  readonly fallback?: TrailerFallback;
}

/**
 * The table of contents of an Insta360 trailer: which records exist and where their payloads
 * lie. Pure data; reading payloads is the caller's job because some are megabytes large.
 */
export class Trailer {
  /**
   * Set when the index record could not be used and the records were walked backwards instead;
   * absent when locating went the way the file promised.
   */
  public readonly fallback: TrailerFallback | undefined;

  private readonly byId: ReadonlyMap<number, RecordLocation>;

  public constructor(
    public readonly footer: TrailerFooter,
    public readonly payloadStart: number,
    contents: TrailerContents,
  ) {
    this.byId = new Map(contents.records.map((record) => [record.id, record]));
    this.fallback = contents.fallback;
  }

  public get records(): readonly RecordLocation[] {
    return [...this.byId.values()];
  }

  public locationOf(id: number): RecordLocation | undefined {
    return this.byId.get(id);
  }
}
