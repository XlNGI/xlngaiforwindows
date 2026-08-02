import type { ErrorObject, ValidateFunction } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import type {
  AdapterCatalogResult,
  AdapterDescriptor,
  AdapterParameters,
  AdapterResolveParams,
  AdapterValidationError,
  AdapterValidationResult,
} from '@ai-video/contracts';

const schemaUri = 'https://json-schema.org/draft/2020-12/schema' as const;

const imageAspectRatios = ['16:9', '9:16', '1:1', '3:4', '4:3'] as const;
const q2ImageAspectRatios = ['auto', ...imageAspectRatios, '21:9', '2:3', '3:2'] as const;

const adapters: AdapterDescriptor[] = [
  {
    key: 'TEXT_TO_IMAGE:vidu:viduq2:v2',
    capability: 'TEXT_TO_IMAGE',
    capabilityLabel: '文生图',
    provider: 'vidu',
    providerLabel: 'Vidu',
    model: 'viduq2',
    modelLabel: 'Vidu Q2 Image',
    apiVersion: 'v2',
    schemaVersion: 1,
    endpoint: 'https://api.vidu.com/ent/v2/reference2image',
    documentationUrl: 'https://platform.vidu.com/docs/reference-to-image',
    credentialProvider: 'vidu',
    parameterSchema: {
      $schema: schemaUri,
      type: 'object',
      additionalProperties: false,
      required: ['prompt', 'aspect_ratio', 'resolution'],
      properties: {
        prompt: {
          type: 'string',
          title: '画面提示词',
          minLength: 1,
          maxLength: 2000,
        },
        aspect_ratio: {
          type: 'string',
          title: '画幅比例',
          enum: [...q2ImageAspectRatios],
          default: '16:9',
        },
        resolution: {
          type: 'string',
          title: '分辨率',
          enum: ['1080p', '2K', '4K'],
          default: '1080p',
        },
        seed: { type: 'integer', title: '随机种子', minimum: 0 },
      },
    },
    uiSchema: {
      fields: [
        { key: 'prompt', control: 'textarea', group: 'basic', order: 10 },
        { key: 'aspect_ratio', control: 'select', group: 'basic', order: 20 },
        { key: 'resolution', control: 'select', group: 'basic', order: 30 },
        { key: 'seed', control: 'number', group: 'advanced', order: 40 },
      ],
    },
  },
  {
    key: 'REFERENCE_TO_IMAGE:vidu:viduq2:v2',
    capability: 'REFERENCE_TO_IMAGE',
    capabilityLabel: '参考生图',
    provider: 'vidu',
    providerLabel: 'Vidu',
    model: 'viduq2',
    modelLabel: 'Vidu Q2 Image',
    apiVersion: 'v2',
    schemaVersion: 1,
    endpoint: 'https://api.vidu.com/ent/v2/reference2image',
    documentationUrl: 'https://platform.vidu.com/docs/reference-to-image',
    credentialProvider: 'vidu',
    parameterSchema: {
      $schema: schemaUri,
      type: 'object',
      additionalProperties: false,
      required: ['images', 'prompt', 'aspect_ratio', 'resolution'],
      properties: {
        images: {
          type: 'array',
          title: '参考图片 URL',
          minItems: 1,
          maxItems: 7,
          items: { type: 'string', format: 'uri' },
        },
        prompt: {
          type: 'string',
          title: '画面提示词',
          minLength: 1,
          maxLength: 2000,
        },
        aspect_ratio: {
          type: 'string',
          title: '画幅比例',
          enum: [...q2ImageAspectRatios],
          default: '16:9',
        },
        resolution: {
          type: 'string',
          title: '分辨率',
          enum: ['1080p', '2K', '4K'],
          default: '1080p',
        },
        seed: { type: 'integer', title: '随机种子', minimum: 0 },
      },
    },
    uiSchema: {
      fields: [
        {
          key: 'images',
          control: 'url-list',
          group: 'basic',
          order: 10,
          placeholder: '每行一个图片 URL',
        },
        { key: 'prompt', control: 'textarea', group: 'basic', order: 20 },
        { key: 'aspect_ratio', control: 'select', group: 'basic', order: 30 },
        { key: 'resolution', control: 'select', group: 'basic', order: 40 },
        { key: 'seed', control: 'number', group: 'advanced', order: 50 },
      ],
    },
  },
  {
    key: 'REFERENCE_TO_IMAGE:vidu:viduq1:v2',
    capability: 'REFERENCE_TO_IMAGE',
    capabilityLabel: '参考生图',
    provider: 'vidu',
    providerLabel: 'Vidu',
    model: 'viduq1',
    modelLabel: 'Vidu Q1 Image',
    apiVersion: 'v2',
    schemaVersion: 1,
    endpoint: 'https://api.vidu.com/ent/v2/reference2image',
    documentationUrl: 'https://platform.vidu.com/docs/reference-to-image',
    credentialProvider: 'vidu',
    parameterSchema: {
      $schema: schemaUri,
      type: 'object',
      additionalProperties: false,
      required: ['images', 'prompt', 'aspect_ratio', 'resolution'],
      properties: {
        images: {
          type: 'array',
          title: '参考图片 URL',
          minItems: 1,
          maxItems: 7,
          items: { type: 'string', format: 'uri' },
        },
        prompt: {
          type: 'string',
          title: '画面提示词',
          minLength: 1,
          maxLength: 2000,
        },
        aspect_ratio: {
          type: 'string',
          title: '画幅比例',
          enum: [...imageAspectRatios],
          default: '16:9',
        },
        resolution: {
          type: 'string',
          title: '分辨率',
          enum: ['1080p'],
          default: '1080p',
        },
        seed: { type: 'integer', title: '随机种子', minimum: 0 },
      },
    },
    uiSchema: {
      fields: [
        {
          key: 'images',
          control: 'url-list',
          group: 'basic',
          order: 10,
          placeholder: '每行一个图片 URL',
        },
        { key: 'prompt', control: 'textarea', group: 'basic', order: 20 },
        { key: 'aspect_ratio', control: 'select', group: 'basic', order: 30 },
        { key: 'resolution', control: 'select', group: 'basic', order: 40 },
        { key: 'seed', control: 'number', group: 'advanced', order: 50 },
      ],
    },
  },
  {
    key: 'IMAGE_TO_VIDEO:vidu:viduq3:v2',
    capability: 'IMAGE_TO_VIDEO',
    capabilityLabel: '图生视频',
    provider: 'vidu',
    providerLabel: 'Vidu',
    model: 'viduq3',
    modelLabel: 'Vidu Q3 参考生视频',
    apiVersion: 'v2',
    schemaVersion: 1,
    endpoint: 'https://api.vidu.com/ent/v2/reference2video',
    documentationUrl: 'https://platform.vidu.com/docs/reference-to-video',
    credentialProvider: 'vidu',
    parameterSchema: {
      $schema: schemaUri,
      type: 'object',
      additionalProperties: false,
      required: ['images', 'prompt', 'duration', 'aspect_ratio', 'resolution', 'audio'],
      properties: {
        images: {
          type: 'array',
          title: '参考图片 URL',
          minItems: 1,
          maxItems: 7,
          items: { type: 'string', format: 'uri' },
        },
        prompt: { type: 'string', title: '视频提示词', minLength: 1, maxLength: 5000 },
        duration: {
          type: 'integer',
          title: '时长（秒）',
          minimum: 3,
          maximum: 16,
          default: 5,
        },
        aspect_ratio: {
          type: 'string',
          title: '画幅比例',
          enum: [...imageAspectRatios],
          default: '16:9',
        },
        resolution: {
          type: 'string',
          title: '分辨率',
          enum: ['540p', '720p', '1080p'],
          default: '720p',
        },
        audio: { type: 'boolean', title: '同步生成声音', default: true },
        seed: { type: 'integer', title: '随机种子', minimum: 0 },
        off_peak: { type: 'boolean', title: '错峰模式', default: false },
      },
    },
    uiSchema: {
      fields: [
        {
          key: 'images',
          control: 'url-list',
          group: 'basic',
          order: 10,
          placeholder: '每行一个参考图片 URL（最多 7 张）',
        },
        { key: 'prompt', control: 'textarea', group: 'basic', order: 20 },
        { key: 'duration', control: 'number', group: 'basic', order: 30 },
        { key: 'aspect_ratio', control: 'select', group: 'basic', order: 40 },
        { key: 'resolution', control: 'select', group: 'basic', order: 50 },
        { key: 'audio', control: 'toggle', group: 'basic', order: 60 },
        { key: 'seed', control: 'number', group: 'advanced', order: 70 },
        { key: 'off_peak', control: 'toggle', group: 'advanced', order: 80 },
      ],
    },
  },
  {
    key: 'IMAGE_TO_VIDEO:vidu:viduq3-pro:v2',
    capability: 'IMAGE_TO_VIDEO',
    capabilityLabel: '图生视频',
    provider: 'vidu',
    providerLabel: 'Vidu',
    model: 'viduq3-pro',
    modelLabel: 'Vidu Q3 Pro 首尾帧',
    apiVersion: 'v2',
    schemaVersion: 1,
    endpoint: 'https://api.vidu.com/ent/v2/start-end2video',
    documentationUrl: 'https://platform.vidu.com/docs/reference-to-video',
    credentialProvider: 'vidu',
    parameterSchema: {
      $schema: schemaUri,
      type: 'object',
      additionalProperties: false,
      required: ['images', 'duration', 'resolution', 'audio'],
      properties: {
        images: {
          type: 'array',
          title: '首帧与尾帧 URL',
          minItems: 2,
          maxItems: 2,
          items: { type: 'string', format: 'uri' },
        },
        prompt: { type: 'string', title: '运动提示词', maxLength: 5000 },
        is_rec: { type: 'boolean', title: '使用推荐提示词', default: false },
        duration: {
          type: 'integer',
          title: '时长（秒）',
          minimum: 1,
          maximum: 16,
          default: 5,
        },
        resolution: {
          type: 'string',
          title: '分辨率',
          enum: ['540p', '720p', '1080p'],
          default: '720p',
        },
        audio: { type: 'boolean', title: '同步生成声音', default: true },
        seed: { type: 'integer', title: '随机种子', minimum: 0 },
        off_peak: { type: 'boolean', title: '错峰模式', default: false },
      },
    },
    uiSchema: {
      fields: [
        {
          key: 'images',
          control: 'url-list',
          group: 'basic',
          order: 10,
          placeholder: '依次输入首帧、尾帧 URL',
        },
        { key: 'prompt', control: 'textarea', group: 'basic', order: 20 },
        { key: 'duration', control: 'number', group: 'basic', order: 30 },
        { key: 'resolution', control: 'select', group: 'basic', order: 40 },
        { key: 'audio', control: 'toggle', group: 'basic', order: 50 },
        { key: 'is_rec', control: 'toggle', group: 'advanced', order: 60 },
        { key: 'seed', control: 'number', group: 'advanced', order: 70 },
        { key: 'off_peak', control: 'toggle', group: 'advanced', order: 80 },
      ],
    },
  },
  {
    key: 'IMAGE_TO_VIDEO:vidu:vidu2.0:v2',
    capability: 'IMAGE_TO_VIDEO',
    capabilityLabel: '图生视频',
    provider: 'vidu',
    providerLabel: 'Vidu',
    model: 'vidu2.0',
    modelLabel: 'Vidu 2.0',
    apiVersion: 'v2',
    schemaVersion: 1,
    endpoint: 'https://api.vidu.com/ent/v2/img2video',
    documentationUrl: 'https://platform.vidu.com/docs/image-to-video',
    credentialProvider: 'vidu',
    parameterSchema: {
      $schema: schemaUri,
      type: 'object',
      additionalProperties: false,
      required: ['images', 'duration', 'resolution', 'movement_amplitude'],
      properties: {
        images: {
          type: 'array',
          title: '起始帧 URL',
          minItems: 1,
          maxItems: 1,
          items: { type: 'string', format: 'uri' },
        },
        prompt: { type: 'string', title: '运动提示词', maxLength: 5000 },
        duration: {
          type: 'integer',
          title: '时长（秒）',
          enum: [4, 8],
          default: 4,
        },
        resolution: {
          type: 'string',
          title: '分辨率',
          enum: ['360p', '720p', '1080p'],
          default: '360p',
        },
        movement_amplitude: {
          type: 'string',
          title: '运动幅度',
          enum: ['auto', 'small', 'medium', 'large'],
          default: 'auto',
        },
        seed: { type: 'integer', title: '随机种子', minimum: 0 },
      },
      allOf: [
        {
          if: { properties: { duration: { const: 8 } }, required: ['duration'] },
          then: { properties: { resolution: { const: '720p' } } },
        },
      ],
    },
    uiSchema: {
      fields: [
        {
          key: 'images',
          control: 'url-list',
          group: 'basic',
          order: 10,
          placeholder: '输入一张起始帧 URL',
        },
        { key: 'prompt', control: 'textarea', group: 'basic', order: 20 },
        { key: 'duration', control: 'select', group: 'basic', order: 30 },
        { key: 'resolution', control: 'select', group: 'basic', order: 40 },
        { key: 'movement_amplitude', control: 'select', group: 'basic', order: 50 },
        { key: 'seed', control: 'number', group: 'advanced', order: 60 },
      ],
    },
  },
];

const keySet = new Set(adapters.map((adapter) => adapter.key));
if (keySet.size !== adapters.length) throw new Error('Adapter keys must be unique.');

const ajv = new Ajv2020({ allErrors: true, strict: true });
const addFormats = addFormatsModule as unknown as (instance: Ajv2020) => Ajv2020;
addFormats(ajv);
const validators = new Map<string, ValidateFunction>();

function validationErrors(errors: ErrorObject[] | null | undefined): AdapterValidationError[] {
  return (errors ?? []).map((error) => ({
    path: error.instancePath || String(error.params.missingProperty ?? ''),
    message: error.message ?? '参数无效',
  }));
}

export function getAdapterCatalog(): AdapterCatalogResult {
  const capabilities = new Map<string, string>();
  const providers = new Map<string, string>();
  for (const adapter of adapters) {
    capabilities.set(adapter.capability, adapter.capabilityLabel);
    providers.set(adapter.provider, adapter.providerLabel);
  }
  return {
    capabilities: [...capabilities].map(([key, label]) => ({
      key: key as AdapterCatalogResult['capabilities'][number]['key'],
      label,
    })),
    providers: [...providers].map(([key, label]) => ({ key, label })),
    adapters,
  };
}

export function getAdapter(adapterKey: string): AdapterDescriptor | undefined {
  return adapters.find((adapter) => adapter.key === adapterKey);
}

export function resolveAdapter(selection: AdapterResolveParams): AdapterDescriptor {
  const matches = adapters.filter(
    (adapter) =>
      adapter.capability === selection.capability &&
      adapter.provider === selection.provider &&
      adapter.model === selection.model &&
      (selection.apiVersion === undefined || adapter.apiVersion === selection.apiVersion),
  );
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? 'No adapter matches the selected capability, provider, model and API version.'
        : 'Adapter selection is ambiguous.',
    );
  }
  return matches[0]!;
}

export function validateAdapterParameters(
  adapterKey: string,
  parameters: AdapterParameters,
): AdapterValidationResult {
  const adapter = getAdapter(adapterKey);
  if (!adapter) {
    return { valid: false, errors: [{ path: '', message: '适配器不存在' }] };
  }
  let validator = validators.get(adapter.key);
  if (!validator) {
    const compiled = ajv.compile(adapter.parameterSchema);
    validators.set(adapter.key, compiled);
    validator = compiled;
  }
  const valid = validator(parameters);
  return { valid: Boolean(valid), errors: validationErrors(validator.errors) };
}
