/**
 * The catalogue of report angles ("focuses").
 *
 * Each focus is an analysis brief for the AI: what to look for, which
 * frameworks to apply, how to score and which tables to produce. The briefs
 * are written in English because they are instructions to the model; the
 * report itself is written in the language the user chose. Names and
 * descriptions shown in the UI live in the locale files under
 * `focus.<id>.name` / `focus.<id>.description`.
 */

export const FOCUS_CATEGORIES = ['efficiency', 'governance', 'quality', 'organisation', 'documentation'] as const;
export type FocusCategory = (typeof FOCUS_CATEGORIES)[number];

export interface Focus {
  id: string;
  category: FocusCategory;
  brief: string;
}

export const CUSTOM_FOCUS_ID = 'custom';

export const FOCUSES: Focus[] = [
  {
    id: 'cost',
    category: 'efficiency',
    brief: `Angle: cost reduction and efficiency.
Find where the process spends money and effort without adding value: manual work, rework loops, duplicate data entry, hand-offs, waiting, approvals that add little, over-processing, overlapping tools, avoidable external spend.
Score: cost efficiency of the current process (100 = lean, little to cut).
Dimensions: Manual effort; Rework and errors; Hand-offs and waiting; Automation level; Control overhead.
Sections:
1. "Cost drivers by step" as a table: Step | Lane | Cost driver | Why it costs | Saving potential (high / medium / low, with the basis).
2. "Quick wins and structural changes": what can be done within weeks versus what needs investment.
3. "Savings estimate and assumptions": only use figures the sources give (volumes, durations, rates). Where they are missing, say which data is needed to size the saving instead of inventing numbers.`,
  },
  {
    id: 'lean',
    category: 'efficiency',
    brief: `Angle: Lean value and waste analysis.
Classify every activity as value-adding (VA), business-value-adding (BVA: required by law, control or the business, but not valued by the customer) or non-value-adding (NVA). Identify the eight wastes (transport, inventory, motion, waiting, overproduction, over-processing, defects, unused skills).
Score: how lean the flow is (100 = almost only value-adding work, continuous flow).
Dimensions: Value-added share; Flow continuity; Waiting; Rework; Standardisation.
Sections:
1. "Value analysis" as a table: Step | Lane | Classification (VA / BVA / NVA) | Waste type | Comment.
2. "Waste summary": the dominant wastes and their root causes.
3. "Future-state ideas": how the flow could look after removing the main wastes.`,
  },
  {
    id: 'bottlenecks',
    category: 'efficiency',
    brief: `Angle: bottlenecks, lead time and flow.
Find where work queues up or stalls: long waits, approvals, dependence on one person or team, batching, steps done in sequence that could run in parallel, loops, hand-offs between lanes, deadlines at risk.
Score: speed and predictability of the flow (100 = fast, smooth, predictable).
Dimensions: Throughput; Waiting time; Hand-offs; Dependencies; Predictability.
Sections:
1. "Process timeline" as a table: Step | Lane | Processing time | Waiting time | Basis. Use the durations stated in the sources; write "not stated" where there is none.
2. "Constraints and critical path": the steps that determine the total lead time, and why.
3. "Ways to shorten lead time".`,
  },
  {
    id: 'automation',
    category: 'efficiency',
    brief: `Angle: automation and AI opportunities.
Assess every task: automation potential (high / medium / low) and the fitting approach (workflow or BPM platform, system integration / API, RPA, document capture / OCR, rules engine, generative-AI assistance, self-service portal). Consider the prerequisites: structured data, stable rules, volume, exception rate.
Score: how far the process is already digital and automated (100 = straight-through processing).
Dimensions: Digital coverage; Data structure; Rule clarity; Integration; Exception handling.
Sections:
1. "Automation candidates" as a table: Step | How it is done today | Potential | Suggested approach | Prerequisites | Effort.
2. "Target picture": how the process would run with the recommended automation, and what stays human.
3. "Risks and change management".`,
  },
  {
    id: 'compliance',
    category: 'governance',
    brief: `Angle: compliance gaps.
Compare the process with the laws, regulations, standards and internal policies that the user named or that clearly apply from the context. Look for missing or weak approvals, missing mandatory checks, missing evidence and records, retention problems, deadlines without monitoring, undocumented exceptions, lack of segregation of duties.
Be careful with legal claims: only cite a requirement when you are confident it exists, name its source, and mark anything uncertain as "to be confirmed with legal / compliance". If no framework was named, assess against generally expected governance practice and say so.
Score: compliance readiness (100 = requirements demonstrably met).
Dimensions: Coverage of requirements; Control design; Evidence and records; Segregation of duties; Monitoring.
Sections:
1. "Requirements versus process" as a table: Requirement | Source | Where addressed (step) | Status (met / partly / gap / unknown) | Gap.
2. "Critical gaps".
3. "Remediation roadmap".`,
  },
  {
    id: 'audit',
    category: 'governance',
    brief: `Angle: auditability and traceability.
Could an auditor reconstruct a single case from start to end? For every step look at what evidence exists (who did what, when, on which basis), whether it lives in a system log or in e-mail, phone calls, paper or memory, whether approvals are attributable, whether records are retained and retrievable, and where manual overrides or undocumented decisions happen.
Score: auditability (100 = every case fully traceable from system records).
Dimensions: Evidence completeness; System traceability; Approval trail; Record retention; Independent review.
Sections:
1. "Audit trail by step" as a table: Step | Evidence produced | Where it is kept | Traceable (yes / partly / no) | Gap.
2. "Walkthrough readiness": what an auditor would be able and unable to verify today.
3. "Improvements".`,
  },
  {
    id: 'risk',
    category: 'governance',
    brief: `Angle: operational risk and internal control.
Build a risk and control matrix. Consider errors, fraud, omissions, delays, data loss, key-person and single-system dependencies, and third-party failure. For each risk judge likelihood and impact (low / medium / high) from the material, identify the existing control (preventive or detective, manual or automated) and the gap.
Score: strength of the control environment (100 = key risks covered by effective controls).
Dimensions: Risk coverage; Preventive controls; Detective controls; Segregation of duties; Resilience.
Sections:
1. "Risk and control matrix" as a table: Risk | Step | Cause | Consequence | Likelihood | Impact | Existing control | Gap | Recommended control.
2. "Segregation of duties" as a table: Conflict | Roles involved | Steps | Recommendation (leave empty if there is none).
3. "Top risks".`,
  },
  {
    id: 'privacy',
    category: 'governance',
    brief: `Angle: personal data protection (LGPD, GDPR and similar laws).
Identify where personal data is collected, used, stored, shared or deleted: which data, whose data, for what purpose, who receives it (including external parties), and how long it is kept. Assess purpose limitation, data minimisation, legal basis (state the likely basis and mark it "to be confirmed"), access control, security, transfers to third parties, retention and the ability to answer data-subject requests. Say when a data protection impact assessment seems advisable. This is not legal advice; say so in the limitations.
Score: privacy readiness (100 = privacy by design demonstrably applied).
Dimensions: Data mapping; Lawfulness and purpose; Minimisation and retention; Security and access; Third parties.
Sections:
1. "Personal data inventory" as a table: Step | Personal data | Data subjects | Purpose | Recipients | Concern.
2. "Gaps against data protection principles".
3. "Recommended measures".`,
  },
  {
    id: 'resilience',
    category: 'governance',
    brief: `Angle: business continuity and resilience.
Find what the process depends on and what happens when it is missing: individuals with unique knowledge, a single approver, one system, one supplier, manual steps with no fallback, peaks in volume, external deadlines.
Score: resilience (100 = no single point of failure, tested fallbacks).
Dimensions: People dependency; System dependency; Third-party dependency; Fallback procedures; Scalability.
Sections:
1. "Dependency map" as a table: Dependency | Type (person / system / supplier / other) | Steps affected | Effect if unavailable | Mitigation.
2. "Disruption scenarios": the two or three most plausible ones and how the process would cope today.
3. "Recommendations".`,
  },
  {
    id: 'quality',
    category: 'quality',
    brief: `Angle: quality and error-proofing.
Find where errors originate, where they are detected and how late, what rework they cause, where criteria are unclear, where work depends on individual care instead of standard work, checklists or system validation (poka-yoke).
Score: built-in quality (100 = first time right, errors prevented at the source).
Dimensions: First-time-right; Error prevention; Detection; Standard work; Feedback loops.
Sections:
1. "Failure modes" as a table: Step | Failure mode | Effect | Cause | How it is detected today | Prevention idea.
2. "Rework loops": each loop in the model, what triggers it and what it costs.
3. "Quality improvements".`,
  },
  {
    id: 'cx',
    category: 'quality',
    brief: `Angle: customer experience.
The customer is whoever the process serves, external or internal. Look at the process through their eyes: how long they wait, how often they must act or chase, what they are told and when, where they must repeat information, where failures become visible to them, how exceptions are handled.
Score: experience delivered (100 = fast, effortless, transparent, reliable).
Dimensions: Speed; Effort; Transparency; Reliability; Communication.
Sections:
1. "Customer journey" as a table: Stage | What the customer does or expects | Process steps behind it | Pain point | Idea.
2. "Moments of truth": the interactions that shape the customer's judgement.
3. "Experience improvements".`,
  },
  {
    id: 'roles',
    category: 'organisation',
    brief: `Angle: roles and responsibilities.
Derive a RACI matrix from the model and the sources: for each activity who is Responsible, Accountable, Consulted and Informed. Flag activities without a clear accountable role, with several, roles that are overloaded or act as a bottleneck, avoidable hand-offs, unclear decision rights and missing escalation paths.
Score: clarity and balance of responsibilities (100 = every step has one clear owner, hand-offs are minimal).
Dimensions: Clarity of ownership; Hand-off efficiency; Workload balance; Decision rights; Escalation.
Sections:
1. "RACI matrix" as a table whose columns are "Step" followed by one column per lane; cells contain R, A, C, I or a combination.
2. "Ownership issues".
3. "Recommended changes".`,
  },
  {
    id: 'systems',
    category: 'organisation',
    brief: `Angle: systems, data and integration.
Map which systems support which steps. Find manual re-typing between systems, spreadsheets and e-mail used as systems of record, missing integrations, data quality problems, duplicated master data, access problems and steps with no system support.
Score: quality of system support (100 = integrated, one source of truth, no re-keying).
Dimensions: System coverage; Integration; Data quality; Shadow IT; Usability.
Sections:
1. "System map" as a table: System | Used in steps | Role in the process | Issues.
2. "Data hand-offs" as a table: From | To | Data | How (manual / automatic) | Risk.
3. "Recommendations".`,
  },
  {
    id: 'kpi',
    category: 'organisation',
    brief: `Angle: KPIs and performance measurement.
Propose a balanced set of indicators for this process covering time, cost, quality, volume, compliance and satisfaction. For each give the definition, the formula, the step where the data originates, the owner and the reporting frequency. Distinguish what can be measured with today's systems from what needs new data capture. Do not invent current values or targets.
Score: measurability and performance management today (100 = measured, owned and acted upon).
Dimensions: Measurability; Data availability; Ownership; Coverage; Use in decisions.
Sections:
1. "KPI catalogue" as a table: KPI | Definition | Formula | Data source (step / system) | Owner | Frequency | Measurable today (yes / partly / no).
2. "Measurement gaps".
3. "Dashboard outline".`,
  },
  {
    id: 'maturity',
    category: 'organisation',
    brief: `Angle: process maturity.
Rate the process on a five-level scale (1 initial / ad hoc, 2 repeatable, 3 defined and standardised, 4 measured and managed, 5 continuously optimised) for each of these dimensions: Documentation and standardisation; Ownership and governance; Measurement; Technology enablement; Control and compliance; Continuous improvement.
Score: overall maturity converted to 0–100 (level 1 = 20, level 5 = 100). In "dimensions" report each dimension the same way and state its level in the comment.
Sections:
1. "Maturity by dimension" as a table: Dimension | Level (1–5) | Evidence | What the next level requires.
2. "Roadmap to the next level".`,
  },
  {
    id: 'sop',
    category: 'documentation',
    brief: `Angle: process documentation (standard operating procedure).
Write the procedure a new employee could follow. Findings are documentation gaps: what the procedure cannot state because the sources were silent or contradictory.
Score: completeness of the information available to document the process (100 = everything needed is known).
Dimensions: Step clarity; Role clarity; Rules and criteria; Exceptions; Records.
Sections:
1. "Purpose and scope": purpose, trigger, outcomes, what is out of scope.
2. "Roles" as a table: Role | Responsibilities in this process.
3. "Procedure" as a table: No. | Step | Responsible | Instructions | System or document | Output.
4. "Decisions and business rules" as a table: Decision | Options | Rule or criterion.
5. "Exceptions and escalation".
6. "Records": what is kept, where and for how long (as far as known).`,
  },
  {
    id: 'executive',
    category: 'documentation',
    brief: `Angle: executive overview (a health check across all angles).
Give leadership a concise, balanced picture: what works well, the most important problems across efficiency, control, compliance, technology and customer experience, and the few priorities that matter most.
Score: overall health of the process (100 = exemplary).
Dimensions: Efficiency; Control; Experience; Technology; Governance.
Sections:
1. "Process at a glance" as a SIPOC table: Suppliers | Inputs | Process (main stages) | Outputs | Customers.
2. "Strengths".
3. "Priorities for the next 90 days".
Keep findings to the eight most important.`,
  },
  {
    id: 'tobe',
    category: 'documentation',
    brief: `Angle: redesign proposal (to-be process).
Propose how the process should run: eliminate steps that add no value, simplify what remains, integrate hand-offs, automate where it pays off. Keep the controls that matter. Be realistic about what the organisation described in the sources can implement.
Score: quality of the current design (100 = little to redesign).
Dimensions: Simplicity; Speed; Control; Automation; Feasibility of change.
Sections:
1. "Design principles".
2. "Change log" as a table: As-is step | Change (remove / merge / simplify / automate / move / new) | To-be description | Benefit.
3. "The redesigned flow": a step-by-step narrative of the to-be process, lane by lane.
4. "Transition plan".`,
  },
];

export function findFocus(id: string): Focus | undefined {
  return FOCUSES.find((focus) => focus.id === id);
}
