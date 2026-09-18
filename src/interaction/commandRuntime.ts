import type { ModelStatePort, RuntimeLogger } from './contracts';

export interface CommandRuntimePort {
  execute(command: string | undefined, state: ModelStatePort): void;
}

export class CommandRuntime implements CommandRuntimePort {
  constructor(private readonly logger: RuntimeLogger) {}

  execute(command: string | undefined, state: ModelStatePort): void {
    if (!command) return;
    for (const rawPart of command.split(';')) {
      const part = rawPart.trim();
      if (!part) continue;
      const tokens = part.split(/\s+/);
      const operation = tokens.shift()?.toLowerCase();
      if (!operation) continue;
      switch (operation) {
        case 'parameters': this.parameters(tokens, state); break;
        case 'varfloat':
        case 'varfloats': this.variable(tokens, state); break;
        case 'hit_areas': state.setHitAreasEnabled(tokens[0]?.toLowerCase() !== 'disable'); break;
        case 'motions': if (tokens[0]) state.setMotionGroupEnabled(tokens[1] ?? '', tokens[0].toLowerCase() !== 'disable'); break;
        default: this.logger.debug('command ignored by domain runtime', { command: part });
      }
    }
  }

  private parameters(tokens: string[], state: ModelStatePort): void {
    const operation = tokens.shift()?.toLowerCase();
    if (operation !== 'lock' && operation !== 'unlock') return;
    for (const name of tokens) {
      if (operation === 'lock') state.lockParameter(name);
      else state.unlockParameter(name);
    }
  }

  private variable(tokens: string[], state: ModelStatePort): void {
    const name = tokens.shift();
    const action = tokens.shift()?.toLowerCase();
    const amount = Number(tokens.shift());
    if (!name || !Number.isFinite(amount)) return;
    const current = state.getVariable(name) ?? 0;
    if (action === 'add') state.setVariable(name, current + amount);
    else if (action === 'sub') state.setVariable(name, current - amount);
    else if (action === 'assign' || action === 'set') state.setVariable(name, amount);
  }
}
