import type {
  IAuthenticateGeneric,
  ICredentialTestRequest,
  ICredentialType,
  INodeProperties,
} from 'n8n-workflow';

export class LangfuseApi implements ICredentialType {
  name = 'langfuseApi';
  displayName = 'Langfuse API';
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
