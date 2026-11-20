import { CONDUCTOR_PIPELINE_TEMPLATES, CONDUCTOR_ROLE_INFO, type ConductorPipelineTemplate } from "@deyin/host-core/shared";

/** The starter pipelines as cards, each showing its stages in order by role. */
export function PipelineTemplateCards({ onPick }: { onPick: (template: ConductorPipelineTemplate) => void }) {
  return (
    <div className="conductor-workflows__templates">
      <h3 className="conductor-workflows__templates-title">Or start from a template</h3>
      <div className="conductor-workflows__template-grid">
        {CONDUCTOR_PIPELINE_TEMPLATES.map((template) => (
          <button key={template.id} type="button" className="conductor-workflows__template" onClick={() => onPick(template)}>
            <span className="conductor-workflows__template-name">{template.name}</span>
            <span className="conductor-workflows__template-summary">{template.summary}</span>
            <span className="conductor-workflows__template-chain">
              {template.stages.map((stage) => CONDUCTOR_ROLE_INFO[stage.role].label).join(" → ")}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
