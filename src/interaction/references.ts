import type { ModelGraph, MotionReference, ResolvedMotionRoute } from './contracts';

export class MotionReferenceParser {
  parse(rawReference: string): MotionReference {
    const raw = rawReference.trim();
    const separator = raw.indexOf(':');
    const group = separator < 0 ? raw : raw.slice(0, separator);
    const suffix = separator < 0 ? undefined : raw.slice(separator + 1);
    const numeric = suffix !== undefined && /^\d+$/.test(suffix) ? Number(suffix) : undefined;
    return {
      raw,
      group,
      name: numeric === undefined ? suffix : undefined,
      index: numeric,
    };
  }

  resolve(rawReference: string, graph: ModelGraph): ResolvedMotionRoute | null {
    return graph.resolve(rawReference);
  }
}
