export function ParameterHelp({ description, label }: { description?: string; label: string }) {
  if (!description) return null;
  return (
    <details className="parameter-help">
      <summary aria-label={`${label}说明`}>填写说明</summary>
      <p>{description}</p>
    </details>
  );
}
