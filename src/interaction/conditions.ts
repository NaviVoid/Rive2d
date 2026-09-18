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
    const conditions = [
      ...entry.conditions,
      ...entry.varFloats.filter(condition => this.isConditionRecord(condition)),
    ];
    return conditions.every(condition => this.evaluateRecord(condition, state));
  }

  private evaluateRecord(condition: JsonRecord, state: ModelStatePort): boolean {
    const code = first(condition, 'Code', 'code');
    if (typeof code === 'string' && code.trim()) {
      return this.evaluateCode(condition, code, state);
    }

    const variable = first(condition, 'Variable', 'variable', 'Param', 'param', 'Id', 'id');
    const variableName = typeof variable === 'string' ? variable : undefined;
    const current = variableName
      ? (state.getVariable(variableName) ?? state.getParameter(variableName) ?? 0)
      : 0;
    const expected = number(first(condition, 'Value', 'value', 'Equal', 'equal', 'Expected', 'expected'));
    if (expected === undefined) return true;
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

  private isConditionRecord(condition: JsonRecord): boolean {
    const type = first(condition, 'Type', 'type');
    if (type === 1 || String(type ?? '').toLowerCase() === 'condition') return true;
    const code = first(condition, 'Code', 'code');
    if (typeof code !== 'string') return false;
    const operator = code.trim().split(/\s+/, 1)[0]?.toLowerCase();
    return !['assign', 'init', 'add', 'subtract', 'sub', 'multiply', 'divide', 'round'].includes(operator);
  }

  private evaluateCode(condition: JsonRecord, code: string, state: ModelStatePort): boolean {
    const parts = code.trim().split(/\s+/);
    const operator = parts.shift()?.toLowerCase();
    const expected = number(parts.join(' '));
    if (!operator || expected === undefined) return true;

    const variable = first(condition, 'Name', 'name', 'Variable', 'variable', 'Param', 'param', 'Id', 'id');
    const variableName = typeof variable === 'string' ? variable : undefined;
    const current = variableName
      ? (variableName.startsWith('@')
        ? (state.getParameter(variableName.substring(1)) ?? 0)
        : (state.getVariable(variableName) ?? state.getParameter(variableName) ?? 0))
      : 0;

    switch (operator) {
      case 'equal':
      case 'equals':
      case 'eq':
        return current === expected;
      case 'not_equal':
      case 'not-equal':
      case 'notequal':
      case 'ne':
        return current !== expected;
      case 'greater':
      case 'greater_than':
      case 'upper':
      case 'gt':
        return current > expected;
      case 'greater_equal':
      case 'greater-than-or-equal':
      case 'upper_equal':
      case 'gte':
        return current >= expected;
      case 'lower':
      case 'less':
      case 'less_than':
      case 'lt':
        return current < expected;
      case 'lower_equal':
      case 'less_equal':
      case 'less-than-or-equal':
      case 'lte':
        return current <= expected;
      default:
        return true;
    }
  }
}
