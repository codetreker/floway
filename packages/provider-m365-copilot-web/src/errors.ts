export class M365CopilotWebError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'M365CopilotWebError';
  }
}

export class M365OAuthError extends M365CopilotWebError {
  readonly requiresInteraction: boolean;

  constructor(
    readonly oauthCode: string,
    message: string,
    readonly terminal: boolean,
    options?: ErrorOptions,
    readonly suberror?: string,
  ) {
    super('oauth_error', message, options);
    this.name = 'M365OAuthError';
    this.requiresInteraction = oauthCode === 'interaction_required'
      || oauthCode === 'consent_required'
      || suberror === 'interaction_required'
      || suberror === 'consent_required';
  }
}

export class M365ProtocolError extends M365CopilotWebError {
  constructor(message: string, options?: ErrorOptions) {
    super('upstream_protocol_error', message, options);
    this.name = 'M365ProtocolError';
  }
}

export class M365UpstreamTurnError extends M365CopilotWebError {
  constructor(
    readonly httpStatus: 429 | 502,
    code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(code, message, options);
    this.name = 'M365UpstreamTurnError';
  }
}

export class M365BusyError extends M365CopilotWebError {
  constructor(message: string) {
    super('account_busy', message);
    this.name = 'M365BusyError';
  }
}

export class M365ProbeRequiredError extends M365CopilotWebError {
  constructor(readonly modelId: string) {
    super('m365_probe_required', `M365 model '${modelId}' requires a fresh successful tone probe`);
    this.name = 'M365ProbeRequiredError';
  }
}

export class M365StateConflictError extends M365CopilotWebError {
  constructor(message: string) {
    super('state_conflict', message);
    this.name = 'M365StateConflictError';
  }
}
