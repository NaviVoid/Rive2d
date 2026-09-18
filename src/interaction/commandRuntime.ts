import type { ModelStatePort, RuntimeLogger } from './contracts';

export interface CommandRuntimePort {
  execute(command: string | undefined, state: ModelStatePort): void;
}

export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let token = '';
  let escaped = false;
  for (const character of command) {
    if (escaped) {
      token += character;
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (/\s/.test(character)) {
      if (token) tokens.push(token);
      token = '';
    } else {
      token += character;
    }
  }
  if (escaped) token += '\\';
  if (token) tokens.push(token);
  return tokens;
}

export class CommandRuntime implements CommandRuntimePort {
  constructor(private readonly logger: RuntimeLogger) {}

  execute(command: string | undefined, state: ModelStatePort): void {
    if (!command) return;
    for (const rawPart of command.split(';')) {
      const part = rawPart.trim();
      if (!part) continue;
      const tokens = tokenizeCommand(part);
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

export interface Live2DCommandHost {
  resolveNumber(rawValue: string | undefined): number;
  lockParameter(id: string, value: number, duration: number): void;
  unlockParameters(ids: readonly string[]): void;
  setParameter(id: string, value: number): void;
  startMotion(reference: string): void;
  stopMotions(layer?: number): void;
  setMouseTracking(enabled: boolean): void;
  setEyeBlink(enabled: boolean): void;
  setPhysics(enabled: boolean): void;
  setMotionGroupEnabled(group: string, enabled: boolean): void;
  setParamHitEnabled(id: string, enabled: boolean): void;
  setParamHitLocked(id: string, locked: boolean): void;
  setHitAreasEnabled(enabled: boolean): void;
  setPartOpacity(id: string, value: number, locked: boolean): void;
  setSoundMuted(muted: boolean): void;
}

/**
 * Command interpreter for model-defined commands. It knows the command
 * protocol, while all engine access stays behind Live2DCommandHost.
 */
export class Live2DCommandRuntime {
  constructor(
    private readonly host: Live2DCommandHost,
    private readonly logger: RuntimeLogger,
  ) {}

  execute(commandString: string | undefined): void {
    if (!commandString) return;
    for (const rawCommand of commandString.split(';')) {
      const command = rawCommand.trim();
      if (command) this.executeOne(command);
    }
  }

  private executeOne(command: string): void {
    const parts = tokenizeCommand(command);
    const verb = parts[0]?.toLowerCase();
    this.logger.debug('command', { command });
    switch (verb) {
      case 'parameters': this.parameters(parts); break;
      case 'start_mtn': this.startMotion(parts); break;
      case 'stop_mtn': this.host.stopMotions(Number.isInteger(Number(parts[1])) ? Number(parts[1]) : 0); break;
      case 'mouse_tracking': this.host.setMouseTracking(parts[1]?.toLowerCase() !== 'disable'); break;
      case 'eye_blink': this.host.setEyeBlink(parts[1]?.toLowerCase() !== 'disable'); break;
      case 'physics': this.host.setPhysics(parts[1]?.toLowerCase() !== 'disable'); break;
      case 'motions': this.motionGroup(parts); break;
      case 'param_hit': this.paramHit(parts); break;
      case 'hit_areas': this.host.setHitAreasEnabled(parts[1]?.toLowerCase() !== 'disable'); break;
      case 'parts': this.parts(parts); break;
      case 'mute_sound': this.host.setSoundMuted(parts[1] === '1'); break;
      case 'artmesh_opacities':
      case 'stop_sound':
      case 'open_url':
      case 'replace_tex':
        this.logger.debug('command deferred or restricted', { command });
        break;
      default:
        this.logger.debug('unknown command', { command });
    }
  }

  private parameters(parts: readonly string[]): void {
    const action = parts[1]?.toLowerCase();
    if (action === 'lock') {
      const ids = parts[2]?.split(',').map(value => value.trim()).filter(Boolean) ?? [];
      for (const id of ids) {
        this.host.lockParameter(id, this.host.resolveNumber(parts[3]), this.host.resolveNumber(parts[4]));
      }
    } else if (action === 'unlock') {
      this.host.unlockParameters(parts[2]?.split(',').map(value => value.trim()).filter(Boolean) ?? []);
    } else if (action === 'set') {
      const ids = parts[2]?.split(',').map(value => value.trim()).filter(Boolean) ?? [];
      for (const id of ids) this.host.setParameter(id, this.host.resolveNumber(parts[3]));
    }
  }

  private startMotion(parts: readonly string[]): void {
    const args = parts.slice(1);
    if (args.length === 0) return;
    // The official command accepts an optional model ID. Rive2d currently has
    // one interactive model, so use the last argument as the motion reference.
    this.host.startMotion(args[args.length - 1]);
  }

  private motionGroup(parts: readonly string[]): void {
    const action = parts[1]?.toLowerCase();
    const group = parts[2];
    if (!group || (action !== 'enable' && action !== 'disable')) return;
    this.host.setMotionGroupEnabled(group, action === 'enable');
  }

  private paramHit(parts: readonly string[]): void {
    const action = parts[1]?.toLowerCase();
    if (!action || !['enable', 'disable', 'lock', 'unlock'].includes(action)) return;
    const ids = parts.slice(2).join(' ').split(',').map(value => value.trim()).filter(Boolean);
    for (const id of ids) {
      if (action === 'enable' || action === 'disable') this.host.setParamHitEnabled(id, action === 'enable');
      else this.host.setParamHitLocked(id, action === 'lock');
    }
  }

  private parts(parts: readonly string[]): void {
    const action = parts[1]?.toLowerCase();
    const id = parts[2];
    const value = Number(parts[3]);
    if (!id || !Number.isFinite(value)) return;
    this.host.setPartOpacity(id, value, action === 'lock');
  }
}
