import type { JsonRecord, ModelStatePort, MotionEntry } from './contracts';

function first(record: JsonRecord, ...keys: string[]): unknown {
  for (const key of keys) if (record[key] !== undefined) return record[key];
  return undefined;
}

function number(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export class ConditionEvaluator {
  evaluate(entry: MotionEntry, state: ModelStatePort): boolean {
    if (entry.enabled === false) return false;
    return entry.conditions.every(condition => this.evaluateRecord(condition, state));
  }

  private evaluateRecord(condition: JsonRecord, state: ModelStatePort): boolean {
    const variable = first(condition, 'Variable', 'variable', 'Param', 'param', 'Id', 'id');
    const variableName = typeof variable === 'string' ? variable : undefined;
    const current = variableName ? (state.getVariable(variableName) ?? state.getParameter(variableName)) : undefined;
    const expected = number(first(condition, 'Value', 'value', 'Equal', 'equal', 'Expected', 'expected'));
    if (current === undefined || expected === undefined) return true;
    if (first(condition, 'NotEqual', 'notEqual', 'not_equal') !== undefined) return current !== expected;
    if (first(condition, 'Min', 'min', 'GreaterOrEqual', 'greaterOrEqual') !== undefined) {
      const min = number(first(condition, 'Min', 'min', 'GreaterOrEqual', 'greaterOrEqual'));
      if (min !== undefined && current < min) return false;
    }
    if (first(condition, 'Max', 'max', 'LessOrEqual', 'lessOrEqual') !== undefined) {
      const max = number(first(condition, 'Max', 'max', 'LessOrEqual', 'lessOrEqual'));
      if (max !== undefined && current > max) return false;
    }
    return first(condition, 'Equal', 'equal', 'Value', 'value', 'Expected', 'expected') === undefined || current === expected;
  }
}
