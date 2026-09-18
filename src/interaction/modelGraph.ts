import type {
  ControllerDefinition,
  HitAreaDefinition,
  JsonRecord,
  ModelGraph,
  MotionEntry,
  ResolvedMotionRoute,
} from './contracts';

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function value(recordValue: JsonRecord, ...keys: string[]): unknown {
  for (const key of keys) if (recordValue[key] !== undefined) return recordValue[key];
  return undefined;
}

function text(recordValue: JsonRecord, ...keys: string[]): string | undefined {
  const item = value(recordValue, ...keys);
  return typeof item === 'string' && item.length > 0 ? item : undefined;
}

function bool(recordValue: JsonRecord, fallback: boolean, ...keys: string[]): boolean {
  const item = value(recordValue, ...keys);
  return item === undefined ? fallback : Boolean(item);
}

function number(recordValue: JsonRecord, fallback: number, ...keys: string[]): number {
  const item = value(recordValue, ...keys);
  const resolved = typeof item === 'number' ? item : Number(item);
  return Number.isFinite(resolved) ? resolved : fallback;
}

function list(valueToRead: unknown): readonly JsonRecord[] {
  return Array.isArray(valueToRead) ? valueToRead.map(record) : [];
}

export class ModelInteractionGraph implements ModelGraph {
  constructor(
    readonly motions: ReadonlyMap<string, readonly MotionEntry[]>,
    readonly hitAreas: readonly HitAreaDefinition[],
    readonly controllers: ReadonlyMap<string, ControllerDefinition>,
  ) {}

  resolve(reference: string): ResolvedMotionRoute | null {
    const raw = reference.trim();
    if (!raw) return null;
    const separator = raw.indexOf(':');
    const rawGroup = separator < 0 ? raw : raw.slice(0, separator);
    const suffix = separator < 0 ? undefined : raw.slice(separator + 1);
    const group = this.findGroup(rawGroup);
    if (!group) return null;
    const entries = this.motions.get(group) ?? [];
    let index: number | undefined;
    let name: string | undefined;
    if (suffix !== undefined && /^\d+$/.test(suffix)) index = Number(suffix);
    else if (suffix !== undefined) {
      name = suffix;
      index = entries.findIndex(entry => entry.name?.toLowerCase() === suffix.toLowerCase());
      if (index < 0) return null;
    }
    const entry = index === undefined ? null : entries[index] ?? null;
    return {
      raw,
      group,
      name: name ?? entry?.name,
      index,
      key: `${group}:${index ?? ''}`,
      entry,
    };
  }

  findMotion(group: string, index?: number): ResolvedMotionRoute | null {
    return this.resolve(index === undefined ? group : `${group}:${index}`);
  }

  findInitEntry(): ResolvedMotionRoute | null {
    let best: { route: ResolvedMotionRoute; score: number } | null = null;
    for (const [group, entries] of this.motions) {
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        if (!entry.file || entry.name?.toLowerCase() !== 'init') continue;
        const normalized = group.toLowerCase();
        const score = normalized === 'init' ? 100 : /^init#\d+$/.test(normalized) ? 90 : normalized.startsWith('init') ? 50 : 0;
        const route = this.findMotion(group, index);
        if (route && (!best || score > best.score)) best = { route, score };
      }
    }
    return best?.route ?? null;
  }

  findIdleGroup(): string | null {
    return this.findGroup('Idle');
  }

  getHitArea(name: string): HitAreaDefinition | null {
    return this.hitAreas.find(area => area.name === name) ?? null;
  }

  private findGroup(group: string): string | null {
    if (this.motions.has(group)) return group;
    const lower = group.toLowerCase();
    return [...this.motions.keys()].find(item => item.toLowerCase() === lower) ?? null;
  }
}

export class JsonModelGraphBuilder {
  build(rawJson: unknown): ModelInteractionGraph {
    const root = record(rawJson);
    const fileReferences = record(root.FileReferences);
    const motionSource = record(fileReferences.Motions ?? root.motions);
    const motions = new Map<string, readonly MotionEntry[]>();
    for (const [group, rawEntries] of Object.entries(motionSource)) {
      const entries = Array.isArray(rawEntries) ? rawEntries.map(item => this.motionEntry(record(item))) : [];
      motions.set(group, entries);
    }

    const rawHitAreas = value(root, 'HitAreas', 'hitAreas', 'hit_areas');
    const hitAreas = Array.isArray(rawHitAreas) ? rawHitAreas.map(item => {
      const area = record(item);
      return {
        name: text(area, 'Name', 'name') ?? '',
        id: text(area, 'Id', 'id'),
        motion: text(area, 'Motion', 'motion'),
        order: number(area, 0, 'Order', 'order'),
        enabled: bool(area, true, 'Enabled', 'enabled'),
      } satisfies HitAreaDefinition;
    }).filter(area => area.name.length > 0) : [];

    const controllerSource = record(root.Controllers ?? root.controllers);
    const controllers = new Map<string, ControllerDefinition>();
    for (const [name, rawConfig] of Object.entries(controllerSource)) {
      const config = record(rawConfig);
      const rawItems = value(config, 'Items', 'items');
      controllers.set(name.toLowerCase(), {
        name,
        enabled: bool(config, true, 'Enabled', 'enabled'),
        items: list(rawItems),
      });
    }
    return new ModelInteractionGraph(motions, hitAreas, controllers);
  }

  private motionEntry(entry: JsonRecord): MotionEntry {
    return {
      ...entry,
      name: text(entry, 'Name', 'name'),
      file: text(entry, 'File', 'file'),
      nextMtn: text(entry, 'NextMtn', 'nextMtn', 'next_mtn'),
      postCommand: text(entry, 'PostCommand', 'postCommand', 'post_command'),
      command: text(entry, 'Command', 'command'),
      enabled: entry.Enabled === undefined && entry.enabled === undefined
        ? true
        : bool(entry, true, 'Enabled', 'enabled'),
      priority: number(entry, 2, 'Priority', 'priority'),
      fileLoop: entry.FileLoop === undefined && entry.fileLoop === undefined
        ? undefined
        : bool(entry, false, 'FileLoop', 'fileLoop'),
      wrapMode: entry.WrapMode === undefined && entry.wrapMode === undefined
        ? undefined
        : number(entry, 0, 'WrapMode', 'wrapMode'),
      varFloats: list(value(entry, 'VarFloats', 'varFloats', 'var_floats')),
      conditions: list(value(entry, 'Conditions', 'conditions')),
    };
  }
}
