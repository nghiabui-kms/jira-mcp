/**
 * Auth layer between this server and Jira.
 *
 * Tools only depend on JiraClient, and JiraClient only depends on this interface,
 * so moving to Atlassian OAuth 2.0 (3LO) later means adding a new implementation
 * (baseUrl = https://api.atlassian.com/ex/jira/{cloudId}, Bearer access token with
 * refresh) and creating one client per user. No tool code has to change.
 */
export interface JiraAuth {
  /** Base URL for REST calls. */
  readonly baseUrl: string;
  /** Headers that authenticate one request. */
  headers(): Promise<Record<string, string>>;
}

/** Basic auth with an Atlassian API token: every call runs as the token owner. */
export class ApiTokenAuth implements JiraAuth {
  private readonly authorization: string;

  constructor(
    readonly baseUrl: string,
    email: string,
    apiToken: string,
  ) {
    this.authorization = "Basic " + Buffer.from(`${email}:${apiToken}`).toString("base64");
  }

  async headers(): Promise<Record<string, string>> {
    return { Authorization: this.authorization };
  }
}
