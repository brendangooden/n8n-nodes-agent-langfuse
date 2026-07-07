import type {
  IAuthenticateGeneric,
  ICredentialTestRequest,
  ICredentialType,
  INodeProperties,
} from 'n8n-workflow';

// Named `agentLangfuseApi` (not `langfuseApi`) deliberately: n8n credential
// type names are a global namespace across community packages. The official
// @langfuse/n8n-nodes-langfuse package also registers `langfuseApi` with a
// different schema (`host` instead of `url`), and when both are installed the
// winner is load-order dependent — n8n then applies the wrong schema's
// defaults to stored data and requests go to the wrong instance.
export class AgentLangfuseApi implements ICredentialType {
  name = 'agentLangfuseApi';
  displayName = 'Agent Langfuse API';
  documentationUrl = 'https://langfuse.com/docs';

  properties: INodeProperties[] = [
    {
      displayName: 'Base URL',
      name: 'url',
      type: 'string',
      default: 'https://cloud.langfuse.com',
      placeholder: 'https://cloud.langfuse.com',
      description: 'The base URL of your Langfuse instance',
    },
    {
      displayName: 'Public Key',
      name: 'publicKey',
      type: 'string',
      default: '',
      required: true,
      typeOptions: { password: true },
    },
    {
      displayName: 'Secret Key',
      name: 'secretKey',
      type: 'string',
      default: '',
      required: true,
      typeOptions: { password: true },
    },
  ];

  authenticate: IAuthenticateGeneric = {
    type: 'generic',
    properties: {
      auth: {
        username: '={{$credentials.publicKey}}',
        password: '={{$credentials.secretKey}}',
      },
    },
  };

  test: ICredentialTestRequest = {
    request: {
      baseURL: '={{$credentials.url}}',
      url: '/api/public/projects',
      method: 'GET',
    },
  };
}
