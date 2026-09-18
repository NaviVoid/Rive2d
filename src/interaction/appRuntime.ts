import { TypedEventBus, type AppRuntimeEvents } from './events';
import type { RuntimeLogger } from './contracts';
import { ConsoleRuntimeLogger } from './logger';
import { ModelRuntime } from './modelRuntime';

export type AppLifecycle = 'booting' | 'ready' | 'loading-model' | 'model-ready' | 'settings' | 'stopped';

export class AppStateMachine {
  private current: AppLifecycle = 'booting';
  get state(): AppLifecycle { return this.current; }
  transition(next: AppLifecycle): void { this.current = next; }
}

export class AppRuntime {
  readonly events = new TypedEventBus<AppRuntimeEvents>();
  readonly stateMachine = new AppStateMachine();
  private readonly logger: RuntimeLogger;
  private currentModel: ModelRuntime | null = null;

  constructor(logger?: RuntimeLogger) {
    this.logger = logger ?? new ConsoleRuntimeLogger('app');
    this.stateMachine.transition('ready');
  }

  get model(): ModelRuntime | null { return this.currentModel; }

  attachModel(model: ModelRuntime): void {
    this.stateMachine.transition('loading-model');
    this.events.emit('model-loading', { id: model.model.id });
    this.currentModel?.dispose();
    this.currentModel = model;
    this.stateMachine.transition('model-ready');
    this.events.emit('model-loaded', { id: model.model.id });
    this.logger.info('model attached', { id: model.model.id });
  }

  detachModel(): void {
    const model = this.currentModel;
    if (!model) return;
    model.dispose();
    this.currentModel = null;
    this.stateMachine.transition('ready');
    this.events.emit('model-unloaded', { id: model.model.id });
  }
}
