import { sessionsDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type { IProvider } from '@/shared/interfaces.js';
import type {
  LLMProvider,
  ProviderCurrentActiveModel,
  ProviderModelsCacheInfo,
  ProviderModelsResult,
  ProviderSessionModel,
} from '@/shared/types.js';

/** Session-row access the service needs, narrowed so tests can stub it. */
type ProviderModelsSessionStore = {
  getSessionById(sessionId: string): { model: string | null } | null;
  setSessionModel(sessionId: string, model: string): void;
};

type ProviderModelsServiceDependencies = {
  resolveProvider?: (provider: LLMProvider) => Pick<IProvider, 'models'>;
  sessions?: ProviderModelsSessionStore;
};

/**
 * Provider model lookup service.
 *
 * Routes and other service callers use this layer instead of resolving provider
 * classes directly so the provider-registry dependency stays centralized in one
 * place.
 */
export const createProviderModelsService = (dependencies: ProviderModelsServiceDependencies = {}) => {
  const resolveProvider = dependencies.resolveProvider ?? providerRegistry.resolveProvider;
  const sessions = dependencies.sessions ?? sessionsDb;
  const pendingRequests = new Map<LLMProvider, Promise<ProviderModelsResult>>();

  const loadModels = (
    provider: LLMProvider,
  ): Promise<ProviderModelsResult> => {
    const request = resolveProvider(provider).models.getSupportedModels()
      .then((models) => {
        const currentTime = Date.now();
        const cache: ProviderModelsCacheInfo = {
          updatedAt: new Date(currentTime).toISOString(),
          expiresAt: new Date(currentTime).toISOString(),
          source: 'fresh',
        };
        return {
          models,
          cache,
        };
      })
      .finally(() => {
        pendingRequests.delete(provider);
      });

    pendingRequests.set(provider, request);
    return request;
  };

  const getProviderModels = async (
    provider: LLMProvider,
    _options?: { bypassCache?: boolean },
  ): Promise<ProviderModelsResult> => {
    const pendingRequest = pendingRequests.get(provider);
    if (pendingRequest) {
      return pendingRequest;
    }

    return loadModels(provider);
  };

  const getCurrentActiveModel = async (
    provider: LLMProvider,
    sessionId?: string,
  ): Promise<ProviderCurrentActiveModel> => resolveProvider(provider).models.getCurrentActiveModel(sessionId);

  const readRecordedSessionModel = (sessionId: string): string | null => {
    const session = sessions.getSessionById(sessionId);
    return session?.model?.trim() || null;
  };

  /**
   * Records the model one session runs with.
   *
   * Called from the active-model route when the user picks a model and from
   * `chat.send` on every turn, so the row always matches what the session last
   * ran with. Sessions the app has not created yet (no row) are ignored rather
   * than treated as an error: the client keeps its own pending selection and
   * the value lands on the row with the first send.
   */
  const setSessionModel = (
    provider: LLMProvider,
    sessionId: string,
    model: string,
  ): ProviderSessionModel | null => {
    const normalizedSessionId = sessionId.trim();
    const normalizedModel = model.trim();
    if (!normalizedSessionId || !normalizedModel) {
      return null;
    }

    if (!sessions.getSessionById(normalizedSessionId)) {
      return null;
    }

    sessions.setSessionModel(normalizedSessionId, normalizedModel);
    return {
      provider,
      sessionId: normalizedSessionId,
      model: normalizedModel,
      source: 'session',
    };
  };

  /**
   * Answers "which model is this session using?" for every display surface.
   *
   * Precedence, highest first:
   *   1. the model recorded on the session row — the user's pick, or whatever
   *      the last send used;
   *   2. the provider's own session state, for sessions started outside the app
   *      that we have never recorded a model for;
   *   3. `requestedModel`, the client's current default, for a chat that has no
   *      session yet;
   *   4. the provider catalog default.
   */
  const resolveSessionModel = async (
    provider: LLMProvider,
    options: { sessionId?: string | null; requestedModel?: string | null } = {},
  ): Promise<ProviderSessionModel> => {
    const normalizedSessionId = typeof options.sessionId === 'string' ? options.sessionId.trim() : '';
    const normalizedRequestedModel = typeof options.requestedModel === 'string'
      ? options.requestedModel.trim()
      : '';

    if (normalizedSessionId) {
      const recordedModel = readRecordedSessionModel(normalizedSessionId);
      if (recordedModel) {
        return {
          provider,
          sessionId: normalizedSessionId,
          model: recordedModel,
          source: 'session',
        };
      }

      const catalog = (await getProviderModels(provider)).models;
      const providerModel = await getCurrentActiveModel(provider, normalizedSessionId);
      const resolvedProviderModel = providerModel.model?.trim();
      if (resolvedProviderModel && resolvedProviderModel !== catalog.DEFAULT) {
        return {
          provider,
          sessionId: normalizedSessionId,
          model: resolvedProviderModel,
          source: 'provider',
        };
      }

      return {
        provider,
        sessionId: normalizedSessionId,
        model: normalizedRequestedModel || catalog.DEFAULT,
        source: normalizedRequestedModel ? 'session' : 'default',
      };
    }

    if (normalizedRequestedModel) {
      return {
        provider,
        sessionId: null,
        model: normalizedRequestedModel,
        source: 'session',
      };
    }

    const catalog = (await getProviderModels(provider)).models;
    return {
      provider,
      sessionId: null,
      model: catalog.DEFAULT,
      source: 'default',
    };
  };

  /**
   * Picks the model one run should use, for provider runtime adapters.
   *
   * Deliberately narrower than `resolveSessionModel`: the provider's own
   * session state is not consulted here.
   */
  const resolveResumeModel = async (
    provider: LLMProvider,
    sessionId: string | undefined,
    requestedModel?: string | null,
  ): Promise<string | undefined> => {
    void provider;
    const normalizedRequestedModel = typeof requestedModel === 'string' ? requestedModel.trim() : '';
    const normalizedSessionId = sessionId?.trim();
    if (!normalizedSessionId) {
      return normalizedRequestedModel || undefined;
    }

    const recordedModel = readRecordedSessionModel(normalizedSessionId);
    return recordedModel || normalizedRequestedModel || undefined;
  };

  const clearCache = (): void => {
    pendingRequests.clear();
  };

  return {
    getProviderModels,
    setSessionModel,
    resolveSessionModel,
    resolveResumeModel,
    clearCache,
  };
};

export const providerModelsService = createProviderModelsService();