// Workspace-bound project creation container normalizes the initial name and sends guarded writes; it never creates automatically.
// New-project form (binds a workspace path).
import React from 'react';
import type * as View from '../model/view-types.ts';
import { normalizeWorkspacePath } from '../model/selectors.ts';
import { createProjectApi as sendCreateProject } from '../api/transport.ts';
import { usePageWrite } from '../hooks/page-navigation.ts';
import { errorText } from '../model/labels.ts';
import { Button, ErrorState, Input } from '../components/primitives.tsx';

export interface CreateProjectProps {
  initialPath?: string;
  onCreated?: (project: View.Project) => void;
  hint?: string;
}






const useState = React.useState;

export function initialName(workspacePath: string) {
  const text = normalizeWorkspacePath(workspacePath);
  if (text === '') return '';
  const parts = text.split('/');
  return parts[parts.length - 1] || '';
}

export function CreateProject(props: CreateProjectProps) {
  const createProjectApi = usePageWrite(sendCreateProject);
  const [workspacePath, setWorkspacePath] = useState(props.initialPath || '');
  const [name, setName] = useState(initialName(props.initialPath || ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function submit() {
    if (busy || String(workspacePath).trim() === '') return;
    setBusy(true);
    setError(null);
    createProjectApi({ workspacePath: String(workspacePath).trim(), name: String(name).trim() || undefined })
      .then(function(value) {
        setBusy(false);
        if (props.onCreated) props.onCreated(value.project);
      })
      .catch(function(reason) {
        setBusy(false);
        setError(errorText(reason));
      });
  }

  return <div className="pb-create">
    <div className="pb-create__head">
      <h2 className="pb-create__title">{'新建项目'}</h2>
      <p className="pb-hint">{props.hint || '项目绑定一个工作区路径；一个工作区可以有多个项目。'}</p>
    </div>
    <div className="pb-create__form">
      <Input
        id="pb-create-path"
        label="工作区绝对路径"
        placeholder="例如 ./demo"
        value={workspacePath}
        onChange={function(event) { setWorkspacePath(event.target.value); }}
        onKeyDown={function(event) { if (event.key === 'Enter') submit(); }}
      />
      <Input
        id="pb-create-name"
        label="名称"
        optional={true}
        placeholder="默认取目录名"
        value={name}
        onChange={function(event) { setName(event.target.value); }}
        onKeyDown={function(event) { if (event.key === 'Enter') submit(); }}
      />
      <Button variant="primary" disabled={busy || String(workspacePath).trim() === ''} onClick={submit}>{busy ? '创建中…' : '创建项目'}</Button>
    </div>
    {error ? <ErrorState message={error} /> : null}
    <p className="pb-hint">{'提示：模型也可以用 project_plan op=publish 自动创建项目。'}</p>
  </div>;
}
