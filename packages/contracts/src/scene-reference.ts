import type { AdapterDescriptor, AdapterParameters } from './index.js';

export interface SceneReferenceImageOptions {
  referenceAssetId?: string;
}

/** Shared requirements for producing one composite scene reference image. */
export const SCENE_REFERENCE_IMAGE_REQUIREMENTS = `# 场景图片创作要求
- 默认将单个场景制作成一张复合参考图：主图是占画面主要面积、清楚呈现空间关系的全景；次图是在边缘或侧栏拼接的关键局部特写。不要把全景与特写拆成多张图片，也不要排成多个等大的视图格。
- 根据场景内容挑选少量有辨识或制作价值的关键细节作为特写；每个特写都应能对应到主全景中真实存在的位置或物件，并保持布局、材质固有色、天气、时段及光源方向一致。不得镜像空间，或增加资料中没有的房间、物件和人物。
- 单个场景默认只准备并生成一张复合图，n=1。只有用户明确要求同版式的多个随机变体时才增加 n；全景与特写属于同一张图的不同分区，不是不同变体或多次请求。
- 保持主次清晰、整体画风与透视一致，特写用于补足全景无法辨认的关键细节。场景资料未说明的内容保持开放或省略；不加标题、说明文字或装饰性边框，除非用户明确要求。`;

/** Preserve authored scene text and ensure direct generation includes the composite layout. */
export function composeSceneReferenceImagePrompt(
  content: string,
  options?: SceneReferenceImageOptions,
): string {
  void options;
  const authored = content.trim();
  if (!authored || authored.endsWith(SCENE_REFERENCE_IMAGE_REQUIREMENTS)) return authored;
  return `${authored}\n\n${SCENE_REFERENCE_IMAGE_REQUIREMENTS}`;
}

/** Defaults for automatic preparation only; reviewed form edits must win afterwards. */
export function sceneReferenceImageParameters(
  adapter: Pick<AdapterDescriptor, 'parameterSchema'>,
  parameters: AdapterParameters,
): AdapterParameters {
  const next = { ...parameters };
  if (adapter.parameterSchema.properties.n) next.n = 1;
  else delete next.n;
  return next;
}

export function prepareSceneReferenceImageProposal(prompt: string, parameters: AdapterParameters) {
  return {
    prompt: composeSceneReferenceImagePrompt(prompt),
    parameters: {
      ...parameters,
      ...(typeof parameters.prompt === 'string'
        ? { prompt: composeSceneReferenceImagePrompt(parameters.prompt) }
        : {}),
      n: 1,
    },
  };
}
