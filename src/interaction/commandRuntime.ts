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

export interface Live2DCommandHost {
  resolveNumber(rawValue: string | undefined): number;
  lockParameter(id: string, value: number, duration: number): void;
  unlockParameters(ids: readonly string[]): void;
  setParameter(id: string, value: number): void;
  startMotion(reference: string): void;
  stopMotions(): void;
  setMouseTracking(enabled: boolean): void;
  setEyeBlink(enabled: boolean): void;
  setPhysics(enabled: boolean): void;
  setMotionGroupEnabled(group: string, enabled: boolean): void;
  setParamHitEnabled(id: string, enabled: boolean): void;
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
    const parts = command.split(/\s+/);
    const verb = parts[0]?.toLowerCase();
    this.logger.debug('command', { command });
    switch (verb) {
      case 'parameters': this.parameters(parts); break;
      case 'start_mtn': this.host.startMotion(parts.slice(1).join(' ').trim()); break;
      case 'stop_mtn': this.host.stopMotions(); break;
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
    const id = parts[2];
    if (!id) return;
    if (action === 'lock') {
      this.host.lockParameter(id, this.host.resolveNumber(parts[3]), this.host.resolveNumber(parts[4]));
    } else if (action === 'unlock') {
      this.host.unlockParameters(id.split(',').map(value => value.trim()).filter(Boolean));
    } else if (action === 'set') {
      this.host.setParameter(id, this.host.resolveNumber(parts[3]));
    }
  }

  private motionGroup(parts: readonly string[]): void {
    const action = parts[1]?.toLowerCase();
    const group = parts[2];
    if (!group || (action !== 'enable' && action !== 'disable')) return;
    this.host.setMotionGroupEnabled(group, action === 'enable');
  }

  private paramHit(parts: readonly string[]): void {
    const action = parts[1]?.toLowerCase();
    if (!action || (action !== 'enable' && action !== 'disable')) return;
    const ids = parts.slice(2).join(' ').split(',').map(value => value.trim()).filter(Boolean);
    for (const id of ids) this.host.setParamHitEnabled(id, action === 'enable');
  }

  private parts(parts: readonly string[]): void {
    const action = parts[1]?.toLowerCase();
    const id = parts[2];
    const value = Number(parts[3]);
    if (!id || !Number.isFinite(value)) return;
    this.host.setPartOpacity(id, value, action === 'lock');
  }
}
