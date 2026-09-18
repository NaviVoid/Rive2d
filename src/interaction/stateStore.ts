import type { ModelStatePort, StateSnapshot } from './contracts';

export class ModelStateStore implements ModelStatePort {
  private readonly variables = new Map<string, number>();
  private readonly parameters = new Map<string, number>();
  private readonly locks = new Map<string, number>();
  private readonly disabledMotionGroups = new Set<string>();
  private disabledHitAreas = false;

  getVariable(name: string): number | undefined { return this.variables.get(name); }
  setVariable(name: string, value: number): void { this.variables.set(name, value); }
  getParameter(name: string): number | undefined { return this.parameters.get(name); }
  setParameter(name: string, value: number): void { this.parameters.set(name, value); }

  lockParameter(name: string, value?: number): void {
    const resolved = value ?? this.parameters.get(name) ?? 0;
    this.locks.set(name, resolved);
    this.parameters.set(name, resolved);
  }

  unlockParameter(name: string): void { this.locks.delete(name); }
  isParameterLocked(name: string): boolean { return this.locks.has(name); }

  setMotionGroupEnabled(group: string, enabled: boolean): void {
    if (enabled) this.disabledMotionGroups.delete(group);
    else this.disabledMotionGroups.add(group);
  }

  setHitAreasEnabled(enabled: boolean): void { this.disabledHitAreas = !enabled; }

  snapshot(): StateSnapshot {
    return {
      variables: new Map(this.variables),
      parameters: new Map(this.parameters),
      locks: new Map(this.locks),
      disabledMotionGroups: new Set(this.disabledMotionGroups),
      disabledHitAreas: this.disabledHitAreas,
    };
  }

  restore(snapshot: StateSnapshot): void {
    this.variables.clear();
    this.parameters.clear();
    this.locks.clear();
    this.disabledMotionGroups.clear();
    for (const [key, value] of snapshot.variables) this.variables.set(key, value);
    for (const [key, value] of snapshot.parameters) this.parameters.set(key, value);
    for (const [key, value] of snapshot.locks) this.locks.set(key, value);
    for (const value of snapshot.disabledMotionGroups) this.disabledMotionGroups.add(value);
    this.disabledHitAreas = snapshot.disabledHitAreas;
  }

  reset(): void {
    this.variables.clear();
    this.parameters.clear();
    this.locks.clear();
    this.disabledMotionGroups.clear();
    this.disabledHitAreas = false;
  }
}
