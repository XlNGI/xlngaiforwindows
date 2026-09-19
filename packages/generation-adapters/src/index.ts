import type { ErrorObject, ValidateFunction } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import {
  UNICOMPAPI_MEDIA_TEMPLATES,
  isUniCompApiMediaTemplateKey,
  uniCompApiTemplateAdapterKey,
  type AdapterCatalogResult,
  type AdapterDescriptor,
  type AdapterParameterSchema,
  type AdapterParameterProperty,
  type AdapterParameters,
  type AdapterResolveParams,
  type AdapterValidationError,
  type AdapterValidationResult,
  type GenerationCapability,
  type UniCompApiMediaTemplateKey,
} from '@ai-video/contracts';

const schemaUri = 'https://json-schema.org/draft/2020-12/schema' as const;

const imageAspectRatios = ['16:9', '9:16', '1:1', '3:4', '4:3'] as const;
const q2ImageAspectRatios = ['auto', ...imageAspectRatios, '21:9', '2:3', '3:2'] as const;
const capabilityOrder: GenerationCapability[] = [
  'TEXT_TO_IMAGE',
  'REFERENCE_TO_IMAGE',
  'TEXT_TO_VIDEO',
  'IMAGE_TO_VIDEO',
  'REFERENCE_TO_VIDEO',
  'START_END_TO_VIDEO',
];

const baseAdapters: AdapterDescriptor[] = [
  {
    key: 'TEXT_TO_IMAGE:vidu:viduq2:v2',
    capability: 'TEXT_TO_IMAGE',
    capabilityLabel: '文生图',
    provider: 'vidu',
    providerLabel: 'Vidu',
    model: 'viduq2',
    modelLabel: 'Vidu Q2',
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
    modelLabel: 'Vidu Q2',
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
          title: '参考图片',
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
          placeholder: '输入公开 URL，或选择本地图片',
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
    modelLabel: 'Vidu Q1',
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
          title: '参考图片',
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
          placeholder: '输入公开 URL，或选择本地图片',
        },
        { key: 'prompt', control: 'textarea', group: 'basic', order: 20 },
        { key: 'aspect_ratio', control: 'select', group: 'basic', order: 30 },
        { key: 'resolution', control: 'select', group: 'basic', order: 40 },
        { key: 'seed', control: 'number', group: 'advanced', order: 50 },
      ],
    },
  },
  {
    key: 'TEXT_TO_VIDEO:vidu:viduq3-pro:v2',
    capability: 'TEXT_TO_VIDEO',
    capabilityLabel: '文生视频',
    provider: 'vidu',
    providerLabel: 'Vidu',
    model: 'viduq3-pro',
    modelLabel: 'Vidu Q3 Pro',
    apiVersion: 'v2',
    schemaVersion: 1,
    endpoint: 'https://api.vidu.com/ent/v2/text2video',
    documentationUrl: 'https://platform.vidu.com/docs/text-to-video',
    credentialProvider: 'vidu',
    parameterSchema: {
      $schema: schemaUri,
      type: 'object',
      additionalProperties: false,
      required: ['prompt', 'duration', 'aspect_ratio', 'resolution', 'audio'],
      properties: {
        prompt: { type: 'string', title: '视频提示词', minLength: 1, maxLength: 5000 },
        duration: {
          type: 'integer',
          title: '时长（秒）',
          minimum: 1,
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
        { key: 'prompt', control: 'textarea', group: 'basic', order: 10 },
        { key: 'duration', control: 'number', group: 'basic', order: 20 },
        { key: 'aspect_ratio', control: 'select', group: 'basic', order: 30 },
        { key: 'resolution', control: 'select', group: 'basic', order: 40 },
        { key: 'audio', control: 'toggle', group: 'basic', order: 50 },
        { key: 'seed', control: 'number', group: 'advanced', order: 60 },
        { key: 'off_peak', control: 'toggle', group: 'advanced', order: 70 },
      ],
    },
  },
  {
    key: 'REFERENCE_TO_VIDEO:vidu:viduq3:v2',
    capability: 'REFERENCE_TO_VIDEO',
    capabilityLabel: '参考生视频',
    provider: 'vidu',
    providerLabel: 'Vidu',
    model: 'viduq3',
    modelLabel: 'Vidu Q3',
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
          title: '参考图片',
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
          placeholder: '输入公开 URL，或选择本地图片（最多 7 张）',
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
    key: 'REFERENCE_TO_VIDEO:vidu:viduq3-drama:v2',
    capability: 'REFERENCE_TO_VIDEO',
    capabilityLabel: '参考生视频',
    provider: 'vidu',
    providerLabel: 'Vidu',
    model: 'viduq3-drama',
    modelLabel: 'Vidu Q3-Drama',
    apiVersion: 'v2',
    schemaVersion: 1,
    endpoint: 'https://api.vidu.com/ent/v2/reference2video',
    documentationUrl: 'https://shengshu.feishu.cn/wiki/URYzwxfMWizDM7kRlCwcRI3Ynzf',
    credentialProvider: 'vidu',
    parameterSchema: {
      $schema: schemaUri,
      type: 'object',
      additionalProperties: false,
      required: ['images', 'prompt', 'duration', 'aspect_ratio', 'resolution', 'audio'],
      properties: {
        images: {
          type: 'array',
          title: '参考图片',
          minItems: 1,
          maxItems: 7,
          items: { type: 'string', format: 'uri' },
        },
        prompt: { type: 'string', title: '视频提示词', minLength: 1, maxLength: 5000 },
        duration: {
          type: 'integer',
          title: '时长（秒）',
          minimum: 2,
          maximum: 15,
          default: 8,
        },
        aspect_ratio: {
          type: 'string',
          title: '画幅比例',
          enum: ['9:16', '16:9'],
          default: '16:9',
        },
        resolution: {
          type: 'string',
          title: '分辨率',
          enum: ['720p', '1080p'],
          default: '1080p',
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
          placeholder: '输入公开 URL，或选择本地图片（最多 7 张）',
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
    key: 'START_END_TO_VIDEO:vidu:viduq3-pro:v2',
    capability: 'START_END_TO_VIDEO',
    capabilityLabel: '首尾帧生视频',
    provider: 'vidu',
    providerLabel: 'Vidu',
    model: 'viduq3-pro',
    modelLabel: 'Vidu Q3 Pro',
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
          title: '首帧与尾帧',
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
          placeholder: '依次输入首帧、尾帧 URL 或本地图片',
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
          title: '起始帧',
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
          placeholder: '输入起始帧公开 URL，或选择本地图片',
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

type ReferenceVideoOffPeakPolicy = { mode: 'unsupported' } | { mode: 'whenAudio'; audio: boolean };

interface ReferenceVideoModelSpec {
  model: string;
  modelLabel: string;
  duration: { min: number; max: number; default: number };
  resolution: readonly string[];
  aspectRatio: readonly string[];
  offPeak: ReferenceVideoOffPeakPolicy;
}

function referenceVideoAdapter(spec: ReferenceVideoModelSpec): AdapterDescriptor {
  const supportsOffPeak = spec.offPeak.mode === 'whenAudio';
  const properties: Record<string, AdapterParameterProperty> = {
    images: {
      type: 'array',
      title: '参考图片',
      minItems: 1,
      maxItems: 7,
      items: { type: 'string', format: 'uri' },
    },
    prompt: { type: 'string', title: '视频提示词', minLength: 1, maxLength: 5000 },
    duration: {
      type: 'integer',
      title: '时长（秒）',
      minimum: spec.duration.min,
      maximum: spec.duration.max,
      default: spec.duration.default,
    },
    aspect_ratio: {
      type: 'string',
      title: '画幅比例',
      enum: [...spec.aspectRatio],
      default: spec.aspectRatio[0],
    },
    resolution: {
      type: 'string',
      title: '分辨率',
      enum: [...spec.resolution],
      default: spec.resolution[0],
    },
    audio: { type: 'boolean', title: '同步生成声音', default: true },
    seed: { type: 'integer', title: '随机种子', minimum: 0 },
  };
  const fields: AdapterDescriptor['uiSchema']['fields'] = [
    {
      key: 'images',
      control: 'url-list',
      group: 'basic',
      order: 10,
      placeholder: '输入公开 URL，或选择本地图片（最多 7 张）',
    },
    { key: 'prompt', control: 'textarea', group: 'basic', order: 20 },
    { key: 'duration', control: 'number', group: 'basic', order: 30 },
    { key: 'aspect_ratio', control: 'select', group: 'basic', order: 40 },
    { key: 'resolution', control: 'select', group: 'basic', order: 50 },
    { key: 'audio', control: 'toggle', group: 'basic', order: 60 },
    { key: 'seed', control: 'number', group: 'advanced', order: 70 },
  ];
  const allOf = supportsOffPeak
    ? [
        {
          if: { properties: { off_peak: { const: true } }, required: ['off_peak'] },
          then: {
            properties: {
              audio: { const: spec.offPeak.mode === 'whenAudio' && spec.offPeak.audio },
            },
          },
        },
      ]
    : undefined;
  if (supportsOffPeak) {
    properties.off_peak = { type: 'boolean', title: '错峰模式', default: false };
    fields.push({ key: 'off_peak', control: 'toggle', group: 'advanced', order: 80 });
  }
  return {
    key: `REFERENCE_TO_VIDEO:vidu:${spec.model}:v2`,
    capability: 'REFERENCE_TO_VIDEO',
    capabilityLabel: '参考生视频',
    provider: 'vidu',
    providerLabel: 'Vidu',
    model: spec.model,
    modelLabel: spec.modelLabel,
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
      properties,
      ...(allOf ? { allOf } : {}),
    },
    uiSchema: { fields },
  };
}

const generatedReferenceVideoAdapters = [
  referenceVideoAdapter({
    model: 'viduq3-ad',
    modelLabel: 'Vidu Q3-Ad',
    duration: { min: 3, max: 15, default: 5 },
    resolution: ['720p', '1080p'],
    aspectRatio: imageAspectRatios,
    offPeak: { mode: 'whenAudio', audio: true },
  }),
  referenceVideoAdapter({
    model: 'viduq3-mix',
    modelLabel: 'Vidu Q3-Mix',
    duration: { min: 3, max: 16, default: 5 },
    resolution: ['720p', '1080p'],
    aspectRatio: imageAspectRatios,
    offPeak: { mode: 'unsupported' },
  }),
  referenceVideoAdapter({
    model: 'viduq3-turbo',
    modelLabel: 'Vidu Q3-Turbo',
    duration: { min: 3, max: 16, default: 5 },
    resolution: ['540p', '720p', '1080p'],
    aspectRatio: imageAspectRatios,
    offPeak: { mode: 'whenAudio', audio: true },
  }),
  referenceVideoAdapter({
    model: 'viduq2-pro',
    modelLabel: 'Vidu Q2 Pro',
    duration: { min: 1, max: 10, default: 5 },
    resolution: ['540p', '720p', '1080p'],
    aspectRatio: imageAspectRatios,
    offPeak: { mode: 'whenAudio', audio: false },
  }),
];

const adapters: AdapterDescriptor[] = [...baseAdapters, ...generatedReferenceVideoAdapters];

const UNICOMPAPI_TEMPLATE_LABELS: Record<UniCompApiMediaTemplateKey, string> = {
  'openai-compatible-image': 'OpenAI 兼容生图',
  'qwen-image-edit': 'Qwen 图编投影',
  'openai-compatible-video': 'OpenAI 兼容生视频',
  'vidu-compatible-reference': 'Vidu 兼容参考视频',
  'vidu-compatible-start-end': 'Vidu 兼容首尾帧',
};

const unicompTextToImageSchema: AdapterParameterSchema = {
  $schema: schemaUri,
  type: 'object',
  additionalProperties: false,
  required: ['prompt'],
  properties: {
    prompt: { type: 'string', title: '提示词', minLength: 1, maxLength: 5000 },
    size: { type: 'string', title: '尺寸', maxLength: 32 },
    n: { type: 'integer', title: '数量', minimum: 1, maximum: 4, default: 1 },
    response_format: {
      type: 'string',
      title: '返回格式',
      enum: ['url', 'b64_json'],
      default: 'url',
    },
    watermark: { type: 'boolean', title: '添加水印' },
  },
};

const unicompImageEditSchema: AdapterParameterSchema = {
  $schema: schemaUri,
  type: 'object',
  additionalProperties: false,
  required: ['images', 'prompt'],
  properties: {
    images: {
      type: 'array',
      title: '输入图片',
      minItems: 1,
      maxItems: 1,
      items: { type: 'string', format: 'uri' },
    },
    prompt: { type: 'string', title: '编辑提示词', minLength: 1, maxLength: 5000 },
    size: { type: 'string', title: '尺寸', maxLength: 32 },
    response_format: {
      type: 'string',
      title: '返回格式',
      enum: ['b64_json'],
      default: 'b64_json',
    },
  },
};

const unicompVideoSchema = (imageRequired: boolean): AdapterParameterSchema => ({
  $schema: schemaUri,
  type: 'object',
  additionalProperties: false,
  required: imageRequired ? ['images', 'prompt'] : ['prompt'],
  properties: {
    ...(imageRequired
      ? {
          images: {
            type: 'array' as const,
            title: '参考图片',
            minItems: 1,
            maxItems: 1,
            items: { type: 'string' as const, format: 'uri' },
          },
        }
      : {}),
    prompt: { type: 'string', title: '视频提示词', minLength: 1, maxLength: 5000 },
    size: { type: 'string', title: '尺寸', maxLength: 32 },
    resolution: { type: 'string', title: '分辨率', maxLength: 16 },
    duration: { type: 'integer', title: '时长（秒）', minimum: 1, maximum: 60, default: 5 },
    seconds: { type: 'string', title: '时长（兼容格式）', maxLength: 16 },
    ratio: { type: 'string', title: '画幅比例', maxLength: 16 },
    generate_audio: { type: 'boolean', title: '生成音频' },
    watermark: { type: 'boolean', title: '添加水印' },
  },
});

function unicompTemplateCommon(templateKey: UniCompApiMediaTemplateKey) {
  return {
    provider: 'unicompapi',
    providerLabel: 'UniCompAPI',
    model: templateKey,
    modelLabel: UNICOMPAPI_TEMPLATE_LABELS[templateKey],
    apiVersion: 'v1',
    schemaVersion: 1,
    documentationUrl: 'https://unicompapi.com',
    credentialProvider: 'unicompapi',
  } as const;
}

function unicompApiTemplateAdapters(): AdapterDescriptor[] {
  const result: AdapterDescriptor[] = [];
  for (const template of UNICOMPAPI_MEDIA_TEMPLATES) {
    const common = unicompTemplateCommon(template.key);
    for (const capability of template.capabilities) {
      if (capability === 'TEXT_TO_IMAGE') {
        result.push({
          ...common,
          key: uniCompApiTemplateAdapterKey(capability, template.key),
          capability,
          capabilityLabel: '文生图',
          endpoint: 'https://unicompapi.com/v1/images/generations',
          parameterSchema: unicompTextToImageSchema,
          uiSchema: {
            fields: [
              { key: 'prompt', control: 'textarea', group: 'basic', order: 10 },
              { key: 'size', control: 'text', group: 'basic', order: 20 },
              { key: 'n', control: 'number', group: 'basic', order: 30 },
              { key: 'response_format', control: 'select', group: 'advanced', order: 40 },
              { key: 'watermark', control: 'toggle', group: 'advanced', order: 50 },
            ],
          },
        });
      } else if (capability === 'REFERENCE_TO_IMAGE') {
        result.push({
          ...common,
          key: uniCompApiTemplateAdapterKey(capability, template.key),
          capability,
          capabilityLabel: '图片编辑',
          endpoint: 'https://unicompapi.com/v1/images/generations',
          parameterSchema: unicompImageEditSchema,
          uiSchema: {
            fields: [
              {
                key: 'images',
                control: 'url-list',
                group: 'basic',
                order: 10,
                placeholder: '输入一张图片 URL 或选择本地图片',
              },
              { key: 'prompt', control: 'textarea', group: 'basic', order: 20 },
              { key: 'size', control: 'text', group: 'basic', order: 30 },
            ],
          },
        });
      } else if (capability === 'TEXT_TO_VIDEO' || capability === 'IMAGE_TO_VIDEO') {
        result.push(
          unicompVideoAdapter(common, template.key, capability, capability === 'IMAGE_TO_VIDEO'),
        );
      } else if (capability === 'REFERENCE_TO_VIDEO') {
        result.push(
          unicompViduCompatibleVideoAdapter(
            common,
            template.key,
            capability,
            'REFERENCE_TO_VIDEO:vidu:viduq3:v2',
          ),
        );
      } else if (capability === 'START_END_TO_VIDEO') {
        result.push(
          unicompViduCompatibleVideoAdapter(
            common,
            template.key,
            capability,
            'START_END_TO_VIDEO:vidu:viduq3-pro:v2',
          ),
        );
      }
    }
  }
  return result;
}

function unicompViduCompatibleVideoAdapter(
  common: ReturnType<typeof unicompTemplateCommon>,
  templateKey: UniCompApiMediaTemplateKey,
  capability: 'REFERENCE_TO_VIDEO' | 'START_END_TO_VIDEO',
  viduAdapterKey: string,
): AdapterDescriptor {
  const viduAdapter = adapters.find((adapter) => adapter.key === viduAdapterKey);
  if (!viduAdapter) throw new Error(`Vidu-compatible adapter ${viduAdapterKey} was not found.`);
  return {
    ...common,
    key: uniCompApiTemplateAdapterKey(capability, templateKey),
    capability,
    capabilityLabel: viduAdapter.capabilityLabel,
    endpoint: 'https://unicompapi.com/v1/videos',
    parameterSchema: viduAdapter.parameterSchema,
    uiSchema: viduAdapter.uiSchema,
  };
}

function unicompVideoAdapter(
  common: ReturnType<typeof unicompTemplateCommon>,
  templateKey: UniCompApiMediaTemplateKey,
  capability: 'TEXT_TO_VIDEO' | 'IMAGE_TO_VIDEO',
  imageRequired: boolean,
): AdapterDescriptor {
  return {
    ...common,
    key: uniCompApiTemplateAdapterKey(capability, templateKey),
    capability,
    capabilityLabel: capability === 'TEXT_TO_VIDEO' ? '文生视频' : '图生视频',
    endpoint: 'https://unicompapi.com/v1/videos',
    parameterSchema: unicompVideoSchema(imageRequired),
    uiSchema: {
      fields: [
        ...(imageRequired
          ? [
              {
                key: 'images',
                control: 'url-list' as const,
                group: 'basic' as const,
                order: 10,
                placeholder: '输入一张参考图片 URL 或选择本地图片',
              },
            ]
          : []),
        { key: 'prompt', control: 'textarea', group: 'basic', order: 20 },
        { key: 'duration', control: 'number', group: 'basic', order: 30 },
        { key: 'size', control: 'text', group: 'basic', order: 40 },
        { key: 'resolution', control: 'text', group: 'basic', order: 50 },
        { key: 'ratio', control: 'text', group: 'advanced', order: 60 },
        { key: 'generate_audio', control: 'toggle', group: 'advanced', order: 70 },
        { key: 'watermark', control: 'toggle', group: 'advanced', order: 80 },
      ],
    },
  };
}

const UNICOMPAPI_CAPABILITY_TEMPLATES: Partial<
  Record<GenerationCapability, UniCompApiMediaTemplateKey>
> = {
  TEXT_TO_IMAGE: 'openai-compatible-image',
  REFERENCE_TO_IMAGE: 'qwen-image-edit',
  TEXT_TO_VIDEO: 'openai-compatible-video',
  IMAGE_TO_VIDEO: 'openai-compatible-video',
  REFERENCE_TO_VIDEO: 'vidu-compatible-reference',
  START_END_TO_VIDEO: 'vidu-compatible-start-end',
};

function parseUniCompAdapterKey(
  adapterKey: string,
): { capability: GenerationCapability; token: string } | undefined {
  const parts = adapterKey.split(':');
  if (parts.length !== 4 || parts[1] !== 'unicompapi' || parts[3] !== 'v1') return undefined;
  const capability = parts[0] as GenerationCapability;
  const token = parts[2] ?? '';
  if (!UNICOMPAPI_CAPABILITY_TEMPLATES[capability] || !token) return undefined;
  if (
    token.trim() !== token ||
    token.length > 256 ||
    [...token].some((value) => value.charCodeAt(0) < 32)
  ) {
    return undefined;
  }
  return { capability, token };
}

function historicalUniCompAdapter(adapterKey: string): AdapterDescriptor | undefined {
  const parsed = parseUniCompAdapterKey(adapterKey);
  if (!parsed || isUniCompApiMediaTemplateKey(parsed.token)) return undefined;
  const templateKey = UNICOMPAPI_CAPABILITY_TEMPLATES[parsed.capability];
  if (!templateKey) return undefined;
  const template = unicompAdapters.find(
    (adapter) => adapter.capability === parsed.capability && adapter.model === templateKey,
  );
  if (!template) return undefined;
  return {
    ...template,
    key: adapterKey,
    model: parsed.token,
    modelLabel: parsed.token,
  };
}

export function adapterBindsCatalogModel(
  adapter: Pick<AdapterDescriptor, 'provider' | 'model'>,
  selection: {
    providerType: string;
    remoteModelId: string;
    parameterTemplateKey?: string;
  },
): boolean {
  if (adapter.provider !== selection.providerType) return false;
  if (selection.providerType === 'unicompapi') {
    return (
      Boolean(selection.parameterTemplateKey) && adapter.model === selection.parameterTemplateKey
    );
  }
  return adapter.model === selection.remoteModelId;
}

export function listUniCompMediaTemplateAdapters(): AdapterDescriptor[] {
  return unicompAdapters.map((adapter) => structuredClone(adapter));
}

function legacyVideoAdapter(currentKey: string, legacyKey: string): AdapterDescriptor {
  const current = adapters.find((adapter) => adapter.key === currentKey);
  if (!current) throw new Error('Current adapter for legacy key ' + legacyKey + ' was not found.');
  return {
    ...current,
    key: legacyKey,
    capability: 'IMAGE_TO_VIDEO',
    capabilityLabel: '图生视频',
  };
}

const legacyAdapters: AdapterDescriptor[] = [
  legacyVideoAdapter('REFERENCE_TO_VIDEO:vidu:viduq3:v2', 'IMAGE_TO_VIDEO:vidu:viduq3:v2'),
  legacyVideoAdapter('START_END_TO_VIDEO:vidu:viduq3-pro:v2', 'IMAGE_TO_VIDEO:vidu:viduq3-pro:v2'),
];

const unicompAdapters = unicompApiTemplateAdapters();
const catalogAdapters = [...adapters, ...unicompAdapters];
const lookupAdapters = [...catalogAdapters, ...legacyAdapters];
const keySet = new Set(lookupAdapters.map((adapter) => adapter.key));
if (keySet.size !== lookupAdapters.length) throw new Error('Adapter keys must be unique.');

const ajv = new Ajv2020({ allErrors: true, strict: true });
const addFormats = addFormatsModule as unknown as (instance: Ajv2020) => Ajv2020;
addFormats(ajv);
const validators = new Map<string, ValidateFunction>();
let runtimeOverrides = new Map<string, AdapterDescriptor>();

/** Replace built-in adapters with confirmed, locally persisted descriptors. */
export function setAdapterOverrides(overrides: AdapterDescriptor[]): void {
  runtimeOverrides = new Map(overrides.map((adapter) => [adapter.key, adapter]));
  validators.clear();
}

function effectiveCatalogAdapters(): AdapterDescriptor[] {
  const byKey = new Map(catalogAdapters.map((adapter) => [adapter.key, adapter]));
  for (const [key, adapter] of runtimeOverrides) byKey.set(key, adapter);
  return [...byKey.values()];
}

function effectiveLookupAdapters(): AdapterDescriptor[] {
  const byKey = new Map(lookupAdapters.map((adapter) => [adapter.key, adapter]));
  for (const [key, adapter] of runtimeOverrides) byKey.set(key, adapter);
  return [...byKey.values()];
}

function validationErrors(errors: ErrorObject[] | null | undefined): AdapterValidationError[] {
  return (errors ?? []).map((error) => ({
    path: error.instancePath || String(error.params.missingProperty ?? ''),
    message: error.message ?? '参数无效',
  }));
}

export function getAdapterCatalog(): AdapterCatalogResult {
  const capabilities = new Map<string, string>();
  const providers = new Map<string, string>();
  const catalog = effectiveCatalogAdapters();
  for (const adapter of catalog) {
    capabilities.set(adapter.capability, adapter.capabilityLabel);
    providers.set(adapter.provider, adapter.providerLabel);
  }
  return {
    capabilities: capabilityOrder
      .filter((key) => capabilities.has(key))
      .map((key) => ({ key, label: capabilities.get(key)! })),
    providers: [...providers].map(([key, label]) => ({ key, label })),
    adapters: catalog,
  };
}

export function getAdapter(adapterKey: string): AdapterDescriptor | undefined {
  return (
    effectiveLookupAdapters().find((adapter) => adapter.key === adapterKey) ??
    historicalUniCompAdapter(adapterKey)
  );
}

export function resolveAdapter(selection: AdapterResolveParams): AdapterDescriptor {
  const matches = effectiveCatalogAdapters().filter(
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

export { extractVideoCost, type VideoGenerationCostInfo } from './extract-video-cost.js';

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
