import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $insertNodeToNearestRoot, mergeRegister } from '@lexical/utils';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $addUpdateTag,
  CLEAR_HISTORY_COMMAND,
  COMMAND_PRIORITY_HIGH,
  DELETE_CHARACTER_COMMAND,
  DecoratorNode,
  HISTORY_PUSH_TAG,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  PASTE_COMMAND,
  PASTE_TAG,
  TextNode,
  SKIP_DOM_SELECTION_TAG,
  type NodeKey,
  type SerializedLexicalNode,
} from 'lexical';
import { Film, Music2, Plus } from 'lucide-react';
import { ParameterImagePreview } from './ParameterImagePreview';
import { splitPromptReferences, type PromptReference } from './prompt-references';

interface ReferenceNodeData extends SerializedLexicalNode {
  reference: PromptReference;
  projectId?: string;
}

const sameReference = (left: PromptReference, right: PromptReference) =>
  left.id === right.id &&
  left.url === right.url &&
  left.text === right.text &&
  left.label === right.label &&
  left.aliases.join('\0') === right.aliases.join('\0');

class ReferenceNode extends DecoratorNode<JSX.Element> {
  __reference: PromptReference;
  __projectId?: string;
  static override getType() {
    return 'prompt-reference';
  }
  static override clone(node: ReferenceNode) {
    return new ReferenceNode(node.__reference, node.__projectId, node.__key);
  }
  static override importJSON(value: SerializedLexicalNode) {
    const data = value as ReferenceNodeData;
    return new ReferenceNode(data.reference, data.projectId);
  }
  constructor(reference: PromptReference, projectId?: string, key?: NodeKey) {
    super(key);
    this.__reference = reference;
    this.__projectId = projectId;
  }
  override exportJSON(): ReferenceNodeData {
    return { ...super.exportJSON(), reference: this.__reference, projectId: this.__projectId };
  }
  override createDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'prompt-reference-token';
    return span;
  }
  override updateDOM() {
    return false;
  }
  override isInline() {
    return true;
  }
  override isKeyboardSelectable() {
    return true;
  }
  override getTextContent() {
    return this.__reference.text;
  }
  override decorate() {
    const reference = this.__reference;
    return (
      <span
        className={`prompt-reference-chip is-${reference.kind}`}
        contentEditable={false}
        data-reference-kind={reference.kind}
      >
        {reference.kind === 'image' ? (
          <ParameterImagePreview
            value={reference.url}
            label={reference.label}
            projectId={this.__projectId}
          />
        ) : reference.kind === 'audio' ? (
          <Music2 size={15} />
        ) : (
          <Film size={15} />
        )}
        <span>{reference.label}</span>
      </span>
    );
  }
}

function EditorBehavior({
  value,
  references,
  projectId,
  onChange,
  maxLength,
  readOnly,
  id,
  label,
  placeholder,
}: PromptReferenceEditorProps) {
  const [editor] = useLexicalComposerContext();
  const [choosing, setChoosing] = useState(false);
  const lastValue = useRef<string | undefined>(undefined);
  const lastReferences = useRef<PromptReference[]>([]);
  const lastProject = useRef<string | undefined>(undefined);
  const refs = useRef(references);
  refs.current = references;
  const scope = useRef(projectId);
  scope.current = projectId;
  useEffect(() => {
    editor.setEditable(!readOnly);
  }, [editor, readOnly]);
  useEffect(() => {
    const referencesChanged =
      lastReferences.current.length !== references.length ||
      references.some(
        (item, index) =>
          !lastReferences.current[index] || !sameReference(item, lastReferences.current[index]),
      );
    if (lastValue.current === value && !referencesChanged && lastProject.current === projectId)
      return;
    lastValue.current = value;
    lastReferences.current = references;
    lastProject.current = projectId;
    editor.update(
      () => {
        const root = $getRoot();
        for (const paragraph of root.getChildren()) {
          if (!$isElementNode(paragraph)) continue;
          for (const node of paragraph.getChildren()) {
            if (referencesChanged && node instanceof TextNode) node.markDirty();
            if (!(node instanceof ReferenceNode)) continue;
            const reference = references.find((item) => item.id === node.__reference.id);
            if (!reference) node.remove();
            else if (!sameReference(reference, node.__reference) || node.__projectId !== projectId)
              node.replace(new ReferenceNode(reference, projectId));
          }
        }
        if (
          root
            .getChildren()
            .map((child) => child.getTextContent())
            .join('\n') === value
        )
          return;
        root.clear();
        for (const line of value.split('\n')) {
          const paragraph = $createParagraphNode();
          for (const part of splitPromptReferences(line, references)) {
            paragraph.append(
              part.reference
                ? new ReferenceNode(part.reference, projectId)
                : $createTextNode(part.text),
            );
          }
          root.append(paragraph);
        }
      },
      { tag: ['external-prompt', SKIP_DOM_SELECTION_TAG] },
    );
    editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined);
  }, [editor, value, references, projectId]);
  useEffect(
    () =>
      editor.registerNodeTransform(TextNode, (node) => {
        const parts = splitPromptReferences(node.getTextContent(), refs.current);
        if (!parts.some((part) => part.reference)) return;
        let offset = 0;
        const offsets = parts.slice(0, -1).map((part) => (offset += part.text.length));
        const nodes = node.splitText(...offsets);
        parts.forEach((part, index) => {
          if (part.reference)
            nodes[index]?.replace(new ReferenceNode(part.reference, scope.current));
        });
      }),
    [editor],
  );
  useEffect(() => {
    const removeAdjacent = (backward: boolean) => {
      if (editor.isComposing()) return false;
      const selection = $getSelection();
      if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
      const anchor = selection.anchor;
      const node = anchor.getNode();
      const adjacent =
        node instanceof TextNode
          ? backward && anchor.offset === 0
            ? node.getPreviousSibling()
            : !backward && anchor.offset === node.getTextContentSize()
              ? node.getNextSibling()
              : null
          : $isElementNode(node)
            ? node.getChildren()[anchor.offset - (backward ? 1 : 0)]
            : null;
      if (!(adjacent instanceof ReferenceNode)) return false;
      $addUpdateTag(HISTORY_PUSH_TAG);
      adjacent.remove();
      return true;
    };
    return mergeRegister(
      editor.registerCommand(
        KEY_BACKSPACE_COMMAND,
        (event) => {
          if (!removeAdjacent(true)) return false;
          event.preventDefault();
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        KEY_DELETE_COMMAND,
        (event) => {
          if (!removeAdjacent(false)) return false;
          event.preventDefault();
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(DELETE_CHARACTER_COMMAND, removeAdjacent, COMMAND_PRIORITY_HIGH),
    );
  }, [editor]);
  useEffect(
    () =>
      editor.registerCommand(
        PASTE_COMMAND,
        (event) => {
          if (!event || !('clipboardData' in event) || !event.clipboardData) return false;
          event.preventDefault();
          $addUpdateTag(PASTE_TAG);
          const selection = $getSelection();
          if ($isRangeSelection(selection))
            selection.insertRawText(event.clipboardData.getData('text/plain'));
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    [editor],
  );
  return (
    <>
      <PlainTextPlugin
        contentEditable={
          <ContentEditable
            id={id}
            className="prompt-reference-input"
            aria-label={label}
            aria-multiline="true"
            aria-readonly={readOnly}
            aria-placeholder={placeholder ?? '输入提示词…'}
            placeholder={
              <span className="prompt-reference-placeholder">{placeholder ?? '输入提示词…'}</span>
            }
          />
        }
        ErrorBoundary={LexicalErrorBoundary}
      />
      <OnChangePlugin
        ignoreSelectionChange
        onChange={(state, _editor, tags) => {
          const text = state.read(() =>
            $getRoot()
              .getChildren()
              .map((child) => child.getTextContent())
              .join('\n'),
          );
          if (tags.has('external-prompt') || text === lastValue.current) return;
          lastValue.current = text;
          onChange(text);
        }}
      />
      <HistoryPlugin />
      {!readOnly && (
        <div className="prompt-reference-tools">
          <button
            type="button"
            className="button subtle"
            aria-expanded={choosing}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setChoosing(!choosing)}
            disabled={!references.length}
          >
            <Plus size={13} />
            插入素材
          </button>
          {maxLength !== undefined && (
            <small className={value.length > maxLength ? 'parameter-error' : ''}>
              {value.length} / {maxLength}
            </small>
          )}
        </div>
      )}
      {choosing && (
        <div className="prompt-reference-options" role="group" aria-label="选择要引用的素材">
          {references.map((reference) => (
            <span key={reference.id} className="prompt-reference-option">
              {reference.kind === 'image' ? (
                <ParameterImagePreview
                  value={reference.url}
                  label={reference.label}
                  projectId={projectId}
                />
              ) : reference.kind === 'audio' ? (
                <Music2 size={15} />
              ) : (
                <Film size={15} />
              )}
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  editor.update(() => {
                    const node = new ReferenceNode(reference, projectId);
                    const selection = $getSelection();
                    if ($isRangeSelection(selection))
                      selection.insertNodes([node, $createTextNode(' ')]);
                    else {
                      $getRoot().selectEnd();
                      $insertNodeToNearestRoot(node);
                    }
                  });
                  editor.focus();
                  setChoosing(false);
                }}
              >
                {reference.label}
              </button>
            </span>
          ))}
        </div>
      )}
    </>
  );
}

export interface PromptReferenceEditorProps {
  id?: string;
  label: string;
  value: string;
  references: PromptReference[];
  projectId?: string;
  onChange: (value: string) => void;
  maxLength?: number;
  readOnly?: boolean;
  placeholder?: string;
}

/** Only the plain provider prompt is saved; chips are a projection of the current inputs. */
export function PromptReferenceEditor(props: PromptReferenceEditorProps) {
  const config = useMemo(
    () => ({
      namespace: 'media-prompt',
      nodes: [ReferenceNode],
      onError: (error: Error) => {
        throw error;
      },
    }),
    [],
  );
  return (
    <div className="prompt-reference-editor">
      <LexicalComposer initialConfig={config}>
        <EditorBehavior {...props} />
      </LexicalComposer>
    </div>
  );
}
