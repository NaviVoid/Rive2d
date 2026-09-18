import type { RuntimeLogger } from './contracts';

export interface MotionResourceRoute {
  readonly group: string;
  readonly index: number;
}

export interface MotionResourceCacheResult {
  readonly requested: number;
  readonly loaded: number;
  readonly failed: number;
  readonly elapsedMs: number;
}

export type MotionResourceLoader<T> = (
  group: string,
  index: number,
) => Promise<T | undefined>;

/** Deduplicates motion loads and limits concurrent parser work. */
export class MotionResourceCache<T = unknown> {
  private readonly tasks = new Map<string, Promise<T | undefined>>();

  constructor(
    private readonly loader: MotionResourceLoader<T>,
    private readonly logger: RuntimeLogger,
  ) {}

  load(route: MotionResourceRoute): Promise<T | undefined> {
    const key = `${route.group}:${route.index}`;
    const existing = this.tasks.get(key);
    if (existing) return existing;

    const task = this.loader(route.group, route.index).catch(error => {
      this.logger.warn('motion resource load failed', {
        route: key,
        error: String(error),
      });
      return undefined;
    });
    this.tasks.set(key, task);
    return task;
  }

  async preload(
    routes: readonly MotionResourceRoute[],
    concurrency = 2,
  ): Promise<MotionResourceCacheResult> {
    const uniqueRoutes = [...new Map(
      routes.map(route => [`${route.group}:${route.index}`, route]),
    ).values()];
    const startedAt = performance.now();
    let cursor = 0;
    let loaded = 0;

    const worker = async (): Promise<void> => {
      while (cursor < uniqueRoutes.length) {
        const route = uniqueRoutes[cursor++];
        const motion = await this.load(route);
        if (motion) loaded += 1;
        // Yield between parser tasks so model setup and rendering can make
        // progress even when a model has many critical motions.
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
    };

    const workerCount = Math.min(Math.max(1, concurrency), uniqueRoutes.length);
    await Promise.all(Array.from({ length: workerCount }, worker));
    const failed = uniqueRoutes.length - loaded;
    return {
      requested: uniqueRoutes.length,
      loaded,
      failed,
      elapsedMs: Math.round(performance.now() - startedAt),
    };
  }

  clear(): void {
    this.tasks.clear();
  }
}
