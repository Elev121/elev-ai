/**
 * analysisEngine.js
 * Four-module ELEV analysis pipeline with detailed narrative feedback:
 *   1. Structural Feedback
 *   2. Citation Review & Score
 *   3. Argument Strength Analysis
 *   4. Integrity Risk Indicators
 */

'use strict';

// ── Helpers ───────────────────────────────────────────────────────
function toGrade(score) {
  if (score >= 85) return 'A';
  if (score >= 75) return 'B';
  if (score >= 65) return 'C';
  if (score >= 50) return 'D';
  return 'F';
}
function clamp(n, min = 0, max = 100) { return Math.max(min, Math.min(max, Math.round(n))); }
function occurrences(text, phrase) {
  let c = 0, pos = 0;
  while ((pos = text.indexOf(phrase, pos)) !== -1) { c++; pos += phrase.length; }
  return c;
}
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// ════════════════════════════════════════════════════════════════════
// MODULE 1 — STRUCTURAL FEEDBACK
// ════════════════════════════════════════════════════════════════════
function analyzeStructure(doc) {
  const { sections, wordCount, sentences } = doc;
  const { present, found } = sections;

  const SECTION_WEIGHTS = {
    abstract:         { weight: 10, required: true  },
    introduction:     { weight: 15, required: true  },
    literatureReview: { weight: 10, required: false },
    methodology:      { weight: 20, required: true  },
    results:          { weight: 20, required: true  },
    discussion:       { weight: 10, required: false },
    conclusion:       { weight: 10, required: true  },
    references:       { weight: 5,  required: true  },
  };

  const sectionDetails = {};
  let structureScore = 0, totalWeight = 0;
  const missingRequired = [];

  Object.entries(SECTION_WEIGHTS).forEach(([key, { weight, required }]) => {
    totalWeight += weight;
    const isPresent = present[key];
    const text  = found[key] || '';
    const words = text.split(/\s+/).filter(Boolean).length;
    let sectionScore = 0;

    const MIN_WORDS = { abstract: 80, introduction: 150, methodology: 200, results: 150, conclusion: 80 };
    const tooShort = MIN_WORDS[key] && isPresent && words < MIN_WORDS[key];

    if (isPresent) {
      sectionScore = tooShort ? Math.round(weight * 0.6) : weight;
    } else {
      if (required) missingRequired.push(cap(key));
    }

    sectionDetails[key] = {
      present: isPresent,
      score: sectionScore,
      maxScore: weight,
      wordCount: isPresent ? words : 0,
      tooShort,
      detailed: generateSectionDetailedFeedback(key, isPresent, words, tooShort),
    };
    structureScore += sectionScore;
  });

  const normalised = clamp((structureScore / totalWeight) * 100);

  // Flow
  const FLOW_MARKERS = ['therefore','consequently','thus','hence','as a result','in contrast',
    'however','on the other hand','furthermore','in addition','moreover','for example',
    'for instance','in summary','to conclude','in conclusion'];
  const fullText  = doc.cleanedText.toLowerCase();
  const flowCount = FLOW_MARKERS.reduce((n, m) => n + occurrences(fullText, m), 0);
  const flowRatio = sentences.length > 0 ? flowCount / sentences.length : 0;
  const flowScore = clamp(flowRatio * 500);

  const paragraphs = doc.cleanedText.split(/\n{2,}/).filter((p) => p.trim().length > 40);
  const avgParLen  = paragraphs.length
    ? paragraphs.reduce((s, p) => s + p.split(/\s+/).length, 0) / paragraphs.length : 0;

  const finalScore = clamp(normalised * 0.7 + flowScore * 0.3);

  const narrative = generateStructuralNarrative({
    score: finalScore, wordCount, pageCount: doc.pageCount,
    missingRequired, sectionDetails, flowCount,
    sentenceCount: sentences.length, flowScore, avgParLen,
  });

  return {
    score: finalScore, grade: toGrade(finalScore),
    sectionScores: sectionDetails,
    flow: { score: flowScore, transitionCount: flowCount, sentenceCount: sentences.length },
    paragraphBalance: { avgWords: Math.round(avgParLen) },
    missingRequired, wordCount, pageCount: doc.pageCount,
    narrative,
    recommendations: buildStructuralRecs(missingRequired, flowScore, avgParLen, wordCount),
  };
}

// ── Section detailed feedback ─────────────────────────────────────
const SECTION_INFO = {
  abstract: {
    purpose: 'The abstract is a reader\'s first encounter with your research. Journals and databases index papers by their abstracts, making it the single most important section for discoverability and initial assessment.',
    idealLength: '150–300 words following the IMRAD structure: Introduction (what is the problem?), Methods (how did you study it?), Results (what did you find?), Discussion (what does it mean?).',
    strongFeedback: 'Your abstract is present and provides a concise overview of the research.',
    weakFeedback: 'Your abstract is present but appears underdeveloped. A thin abstract signals to reviewers that key findings may be unclear.',
    missingFeedback: 'Without an abstract, readers cannot quickly assess the relevance of your research. Automated systems will be unable to index or categorise it.',
    improvementTip: 'Revise your abstract to explicitly state: (1) the research problem, (2) the methodology used, (3) the key finding, and (4) the main implication or conclusion.',
    example: 'Example opening: "This study investigates [problem] using [method]. Results indicate that [finding], suggesting [implication]."',
  },
  introduction: {
    purpose: 'The introduction contextualises your research by moving from broad background to a specific gap in knowledge. Without it, readers have no framework for interpreting your findings.',
    idealLength: '10–15% of the total paper. It should funnel from broad topic → specific problem → research question.',
    strongFeedback: 'Your introduction effectively sets up the research context and research questions.',
    weakFeedback: 'Your introduction is detected but may lack sufficient context, literature grounding, or a clear statement of the research question.',
    missingFeedback: 'The absence of an introduction means your research starts without context. Reviewers may struggle to understand why the study was necessary.',
    improvementTip: 'Structure your introduction as: (1) broad background (2–3 sentences), (2) narrowing to the specific problem, (3) a brief review of what others have done, (4) the gap, and (5) your research objective.',
    example: 'Avoid starting with vague statements like "Research is important." Instead: "Despite extensive work on X [cite], the relationship between Y and Z remains poorly understood [cite]."',
  },
  methodology: {
    purpose: 'The methodology is the foundation of reproducible, verifiable research. It enables other researchers to replicate your study and validates the credibility of your findings.',
    idealLength: '15–25% of the paper for empirical studies. Must cover: research design, data sources, instruments, analysis method, and ethical considerations.',
    strongFeedback: 'Your methodology section is present and provides a reasonable account of how the research was conducted.',
    weakFeedback: 'Your methodology section is present but is too brief to fully justify your research approach. Reviewers need enough detail to assess and replicate the study.',
    missingFeedback: 'This is the most critical missing section. Without a methodology, your results cannot be verified, replicated, or trusted. Any empirical claims become unsubstantiated.',
    improvementTip: 'At minimum, your methodology must address: (1) research design type (qualitative/quantitative/mixed), (2) where your data came from, (3) how it was collected, (4) how it was analysed, and (5) any limitations in your approach.',
    example: '"A cross-sectional survey was administered to 120 undergraduate students (n=120, mean age=21.3) using a 5-point Likert scale instrument. Data were analysed using SPSS v26, applying descriptive statistics and Pearson\'s correlation."',
  },
  results: {
    purpose: 'The results section presents findings objectively without interpretation. It answers your research questions with evidence — numerical data, patterns, quotes, or observations.',
    idealLength: '20–30% of the paper. Each result should map directly to a research question or hypothesis.',
    strongFeedback: 'Your results section is present and appears to present findings systematically.',
    weakFeedback: 'Your results section exists but may be combining findings with interpretation, or presenting data without sufficient organisation.',
    missingFeedback: 'Without a results section, your research has no reported findings. The paper\'s core scientific contribution is absent.',
    improvementTip: 'Present results in the same order as your research questions. Use numbered subheadings. Every figure or table must be referenced in the text with a brief explanatory sentence.',
    example: '"Table 1 shows a statistically significant positive correlation between X and Y (r = 0.72, p < 0.01), consistent with Hypothesis 1. However, no significant relationship was found for Z (r = 0.08, p = 0.43)."',
  },
  discussion: {
    purpose: 'The discussion interprets what your results mean in the broader context of existing research. It connects your findings back to the literature and your research questions.',
    idealLength: '15–20% of the paper. The key structure: restate finding → compare to prior work → explain unexpected results → acknowledge limitations → implications.',
    strongFeedback: 'Your discussion section is present and appears to contextualise results within the broader literature.',
    weakFeedback: 'Your discussion section is present but may need more engagement with prior research or a deeper interpretation of your findings.',
    missingFeedback: 'Without a discussion, your results are left uninterpreted. Readers cannot understand what the findings mean or how they advance knowledge in your field.',
    improvementTip: 'For each major finding, ask: "What does this mean? Why did this happen? How does it relate to [Author, Year]?" This line of questioning drives quality discussion writing.',
    example: '"The finding that X correlates positively with Y (r=0.72) aligns with Smith and Jones (2022), who reported similar patterns in [context]. This suggests [explanation]. Unlike Brown et al. (2021), however, our sample showed [difference], possibly due to [reason]."',
  },
  conclusion: {
    purpose: 'The conclusion synthesises the research without introducing new evidence. It should answer: What was found? Why does it matter? What should happen next?',
    idealLength: '5–10% of the paper. Should NOT be a simple restatement of the abstract.',
    strongFeedback: 'Your conclusion is present and provides a summary of the research outcomes.',
    weakFeedback: 'Your conclusion is present but may be too brief, or may simply repeat the abstract rather than synthesising the research journey.',
    missingFeedback: 'A paper without a conclusion feels abrupt and unfinished. Reviewers and readers expect a clear wrap-up that reinforces the paper\'s contribution.',
    improvementTip: 'Structure your conclusion: (1) one-sentence answer to your research question, (2) brief synthesis of key findings, (3) theoretical or practical contribution, (4) main limitation, (5) future research direction.',
    example: '"This study demonstrates that [main finding], contributing to the understanding of [field]. While limited by [constraint], these findings suggest that [implication]. Future research should explore [next steps]."',
  },
  references: {
    purpose: 'References give intellectual credit to prior work, allow readers to verify your claims, and demonstrate the depth of your literature engagement. Every factual or theoretical claim requires a citation.',
    idealLength: 'No fixed length — determined by the paper\'s scope. Journal articles typically have 20–50 references; theses may have 100+.',
    strongFeedback: 'Your references section is present and appears to contain a structured list of sources.',
    weakFeedback: 'Your references section is present but may be incomplete or inconsistently formatted.',
    missingFeedback: 'The complete absence of a reference section is a serious academic integrity concern. All claims based on prior work must be attributed.',
    improvementTip: 'Audit your references: (1) every in-text citation must appear in the list and vice versa, (2) use one consistent format (APA, IEEE, MLA, etc.), (3) include DOIs, (4) prioritise peer-reviewed sources.',
    example: 'APA example: "Smith, J., & Jones, A. (2023). Title of the article. Journal Name, 45(2), 112–130. https://doi.org/10.xxxx"',
  },
  literatureReview: {
    purpose: 'The literature review situates your research within the scholarly conversation, identifies what is known and unknown, and justifies why your study is needed.',
    idealLength: '15–25% of a thesis or dissertation. In journal articles it is often integrated into the introduction.',
    strongFeedback: 'Your literature review is present and positions your research in the context of prior work.',
    weakFeedback: 'Your literature review is present but may read as a list of summaries rather than a critical synthesis of existing knowledge.',
    missingFeedback: 'Without a literature review, readers cannot assess whether your research is novel or whether you are aware of prior work in the area.',
    improvementTip: 'Move beyond summarising individual papers. Group sources thematically: "Several studies have examined X [cite, cite], while others focus on Y [cite, cite]. However, the relationship between X and Y has not been explored [gap]."',
    example: '"While Garcia (2020) and Lee (2021) both found that X correlates with Y in Western contexts, no study has examined this relationship in [your specific context], leaving a significant gap in the literature."',
  },
};

function generateSectionDetailedFeedback(key, isPresent, wordCount, tooShort) {
  const info = SECTION_INFO[key] || {
    purpose: 'This section contributes to the overall academic structure.',
    idealLength: 'Discipline-dependent.', strongFeedback: 'Section is present.',
    weakFeedback: 'Section needs development.', missingFeedback: 'Section not found.',
    improvementTip: 'Expand this section.', example: '',
  };

  let status, statusMessage, detailMessage;
  if (!isPresent) {
    status = 'missing';
    statusMessage = info.missingFeedback;
    detailMessage = `Purpose: ${info.purpose}`;
  } else if (tooShort) {
    status = 'weak';
    statusMessage = info.weakFeedback;
    detailMessage = `This section was found but contains only ~${wordCount} words, which is below the recommended minimum. Purpose: ${info.purpose}`;
  } else {
    status = 'strong';
    statusMessage = info.strongFeedback;
    detailMessage = `Purpose: ${info.purpose}`;
  }

  return { status, statusMessage, detailMessage, purpose: info.purpose, idealLength: info.idealLength, improvementTip: info.improvementTip, example: info.example };
}

// ── Structural narrative ──────────────────────────────────────────
function generateStructuralNarrative({ score, wordCount, pageCount, missingRequired, sectionDetails, flowCount, sentenceCount, flowScore, avgParLen }) {
  // Overall assessment
  let overallTone;
  if (score >= 85)      overallTone = 'Your paper demonstrates a strong structural foundation that meets academic writing standards.';
  else if (score >= 70) overallTone = 'Your paper has a solid structural base, though targeted improvements are needed in several areas.';
  else if (score >= 55) overallTone = 'Your paper shows an attempt at academic structure, but significant gaps weaken the overall presentation and credibility.';
  else                  overallTone = 'Your paper has critical structural deficiencies. Essential sections are missing or underdeveloped, which will likely lead to rejection in any formal academic review.';

  // Word count context
  let wordContext;
  if (wordCount < 800) wordContext = `At only ~${wordCount} words, your paper is far shorter than expected for academic research. Most journal articles require 4,000–8,000 words; even short papers typically exceed 2,000. This length makes it impossible to adequately cover all required sections with the depth reviewers expect.`;
  else if (wordCount < 2000) wordContext = `Your paper is ${wordCount} words long. While sufficient for a short research report, most academic papers require greater depth. Ensure each section is fully developed rather than being skimmed over.`;
  else if (wordCount < 5000) wordContext = `At ${wordCount} words across ${pageCount} page(s), your paper is within a reasonable range for a coursework or conference submission. The priority should be ensuring this word count is well-distributed across all required sections rather than being concentrated in only one or two.`;
  else wordContext = `At ${wordCount} words, your paper is comprehensive in length. With this level of detail, maintaining clear logical flow and section balance becomes critically important — readers and reviewers can easily lose track of the core argument in lengthy papers that lack tight structure.`;

  // Flow narrative
  let flowNarrative;
  if (flowScore >= 80) flowNarrative = `Your paper uses ${flowCount} transitional phrases across ${sentenceCount} sentences — an excellent density. Phrases like "therefore", "consequently", and "furthermore" are not decorative: they signal the logical relationship between ideas, helping readers follow your reasoning. This level of transition use is characteristic of polished academic writing.`;
  else if (flowScore >= 55) flowNarrative = `Your paper contains ${flowCount} transitional phrases across ${sentenceCount} sentences. This is somewhat low. Without adequate transitions, even well-reasoned arguments can appear as a series of disconnected statements rather than a coherent argument. Reviewers often note "poor flow" when transitions are sparse.`;
  else flowNarrative = `Your paper uses very few transitional phrases (${flowCount} across ${sentenceCount} sentences). This is a significant weakness. In academic writing, transitions do the heavy lifting of logical reasoning — they show *why* one idea follows from another. Without them, your paper may read like a list of facts rather than a scholarly argument. Target at least one logical connector (e.g., "therefore", "however", "this suggests") per paragraph.`;

  // Paragraph balance
  let paraBalance = '';
  if (avgParLen < 40) paraBalance = ' Your paragraphs are also very short on average, which can fragment complex ideas that need fuller development.';
  else if (avgParLen > 250) paraBalance = ' Your paragraphs tend to be excessively long, which can overwhelm readers. Each paragraph should focus on a single idea — consider splitting dense paragraphs.';

  // Missing sections impact
  let missingImpact = '';
  if (missingRequired.length > 0) {
    const impactMap = {
      Abstract: 'makes the paper undiscoverable to search engines and uninviting to reviewers',
      Introduction: 'leaves readers without the context needed to evaluate your claims',
      Methodology: 'makes your results unverifiable and untrustworthy — this is the most serious structural deficiency',
      Results: 'means the paper lacks its primary scientific contribution',
      Conclusion: 'leaves the paper feeling unfinished and the research implications unstated',
    };
    const impacts = missingRequired.map((s) => `${s} (${impactMap[s] || 'weakens overall credibility'})`);
    missingImpact = ` Critical sections are absent: ${impacts.join('; ')}. Each missing section significantly reduces the paper's academic credibility.`;
  }

  return {
    summary: `${overallTone}${missingImpact}`,
    wordCountAnalysis: wordContext,
    flowAnalysis: `${flowNarrative}${paraBalance}`,
    positives: buildStructuralPositives(sectionDetails, flowScore, wordCount),
    watchPoints: buildStructuralWatchPoints(missingRequired, flowScore, avgParLen),
  };
}

function buildStructuralPositives(sectionDetails, flowScore, wordCount) {
  const positives = [];
  const strongSections = Object.entries(sectionDetails).filter(([, v]) => v.present && !v.tooShort).map(([k]) => cap(k));
  if (strongSections.length > 0) positives.push(`${strongSections.join(', ')} section${strongSections.length > 1 ? 's are' : ' is'} present and sufficiently developed.`);
  if (flowScore >= 60) positives.push('Logical transitions are used consistently, aiding reader comprehension.');
  if (wordCount >= 2000) positives.push('Word count is within the range expected for academic submissions.');
  return positives.length ? positives : ['Review your paper to identify and build on existing structural strengths.'];
}

function buildStructuralWatchPoints(missingRequired, flowScore, avgParLen) {
  const points = [];
  if (missingRequired.length) points.push(`Missing required section(s): ${missingRequired.join(', ')}`);
  if (flowScore < 55) points.push('Very low use of logical transitions — the argument lacks visible connective tissue.');
  if (avgParLen < 40) points.push('Paragraphs are excessively short — ideas need fuller development.');
  if (avgParLen > 250) points.push('Paragraphs are too long — break them up for clarity.');
  return points;
}

function buildStructuralRecs(missingRequired, flowScore, avgParLen, wordCount) {
  const recs = [];
  if (missingRequired.length) recs.push(...missingRequired.map((s) => `Add a "${s}" section — see the section guide in the detailed analysis below.`));
  if (flowScore < 55) recs.push('Add at least one transitional phrase per paragraph (e.g., "therefore", "however", "this suggests", "as a result").');
  if (avgParLen < 40) recs.push('Expand each paragraph to develop a single idea fully — aim for 80–150 words per paragraph.');
  if (wordCount < 1500) recs.push('Significantly expand the paper. Aim for a minimum of 3,000 words for a research article.');
  if (!recs.length) recs.push('Maintain current structural standards. Focus on depth and clarity within each section.');
  return recs;
}

// ════════════════════════════════════════════════════════════════════
// MODULE 2 — CITATION REVIEW & SCORE
// ════════════════════════════════════════════════════════════════════
function analyzeCitations(doc) {
  const text   = doc.cleanedText;
  const format = doc.metadata.citationFormat;

  const APA_PATTERN  = /\(([A-Z][a-zA-Z\-]+(?:\s+(?:et\s+al\.?|&\s+[A-Z][a-zA-Z]+))?,\s*\d{4}[a-z]?(?:,\s+pp?\.\s+\d+[-–]?\d*)?)\)/g;
  const IEEE_PATTERN = /\[(\d+(?:,\s*\d+)*)\]/g;
  const MLA_PATTERN  = /\(([A-Z][a-zA-Z\-]+(?:\s+and\s+[A-Z][a-zA-Z]+)?\s+\d{1,4})\)/g;

  const apaMatches  = [...text.matchAll(APA_PATTERN)];
  const ieeeMatches = [...text.matchAll(IEEE_PATTERN)];
  const mlaMatches  = [...text.matchAll(MLA_PATTERN)];

  let inTextCitations = [], detectedFormat = format;
  if (apaMatches.length >= ieeeMatches.length && apaMatches.length >= mlaMatches.length) {
    inTextCitations = apaMatches.map((m) => m[1]); detectedFormat = 'APA';
  } else if (ieeeMatches.length > apaMatches.length) {
    inTextCitations = ieeeMatches.map((m) => m[1]); detectedFormat = 'IEEE';
  } else {
    inTextCitations = mlaMatches.map((m) => m[1]); detectedFormat = 'MLA';
  }

  const uniqueCitations  = [...new Set(inTextCitations)];
  const refSection       = doc.sections.found['references'] || '';
  const refLines         = refSection.split('\n').map((l) => l.trim()).filter((l) => l.length > 20 && /[A-Z]/.test(l[0]));
  const referencesListed = refLines.length;
  const inTextCount      = inTextCitations.length;
  const uniqueCount      = uniqueCitations.length;

  const formatMix  = Math.min(apaMatches.length, ieeeMatches.length);
  const formatScore = formatMix > 3 ? clamp(100 - formatMix * 5) : 95;
  const wordsPerCitation = uniqueCount > 0 ? doc.wordCount / uniqueCount : Infinity;

  let densityScore = 70, densityLabel = 'adequate';
  if (uniqueCount === 0)           { densityScore = 10; densityLabel = 'none'; }
  else if (wordsPerCitation > 500) { densityScore = 50; densityLabel = 'sparse'; }
  else if (wordsPerCitation < 50)  { densityScore = 75; densityLabel = 'dense'; }
  else                             { densityScore = 85; densityLabel = 'good'; }

  const issues = [];
  if (referencesListed > 0 && Math.abs(referencesListed - uniqueCount) > 3) issues.push(`Citation count mismatch: ~${uniqueCount} in-text citation(s) vs ${referencesListed} reference entries.`);
  if (uniqueCount === 0) issues.push('No in-text citations detected.');
  if (!doc.sections.present['references']) issues.push('No reference section detected.');
  if (densityLabel === 'sparse') issues.push('Low citation density — claims may be under-supported.');
  if (formatScore < 80) issues.push('Mixed citation formats detected.');

  const finalScore = clamp(densityScore * 0.5 + formatScore * 0.3 + (referencesListed > 0 ? 85 : 40) * 0.2);

  const narrative = generateCitationNarrative({
    score: finalScore, inTextCount, uniqueCount, referencesListed,
    detectedFormat, formatScore, densityScore, densityLabel,
    wordsPerCitation: isFinite(wordsPerCitation) ? Math.round(wordsPerCitation) : null,
    wordCount: doc.wordCount, hasRefSection: doc.sections.present['references'],
  });

  return {
    score: finalScore, grade: toGrade(finalScore),
    inTextCount, uniqueCitations: uniqueCount, referencesListed,
    citationFormat: detectedFormat, formatConsistencyScore: formatScore,
    densityScore, densityLabel, issues, narrative,
    recommendations: buildCitationRecs(densityLabel, formatScore, doc.sections.present['references'], uniqueCount),
  };
}

function generateCitationNarrative({ score, inTextCount, uniqueCount, referencesListed, detectedFormat, formatScore, densityScore, densityLabel, wordsPerCitation, wordCount, hasRefSection }) {
  // Overall
  let overall;
  if (score >= 85)      overall = 'Your paper demonstrates a strong citation practice with consistent formatting and adequate source density.';
  else if (score >= 70) overall = 'Your citation practice is reasonably good, but some areas — particularly citation density or format consistency — need attention.';
  else if (score >= 50) overall = 'Your paper has notable citation weaknesses. Under-citation is one of the most common reasons academic papers are rejected or downgraded.';
  else                  overall = 'Your paper has critical citation deficiencies. Without proper citations, academic claims are unsupported assertions, which violates fundamental academic integrity standards.';

  // Density analysis
  let densityNarrative;
  if (densityLabel === 'none') {
    densityNarrative = 'No in-text citations were detected. Every factual claim, statistic, theory, or argument derived from prior work must be cited. Without citations, your paper cannot be distinguished from original unsubstantiated opinion. This is likely the most urgent issue to address.';
  } else if (densityLabel === 'sparse') {
    const ratio = wordsPerCitation ? `approximately one citation per ${wordsPerCitation} words` : 'very few citations';
    densityNarrative = `Your citation density is low (${ratio}). In academic writing, a general guideline is to include at least one citation per major claim. For a ${wordCount}-word paper with ${uniqueCount} unique source${uniqueCount !== 1 ? 's' : ''}, many claims are likely left unsupported. Reviewers specifically look for evidence that assertions are grounded in the literature.`;
  } else if (densityLabel === 'dense') {
    densityNarrative = `Your paper has a high citation density (${inTextCount} in-text citation${inTextCount !== 1 ? 's' : ''} across ${wordCount} words). While comprehensive sourcing is valued, be careful that your own analysis and argument are not buried under citations. Your paper must have an identifiable original voice and contribution — not just a recitation of what others have said.`;
  } else {
    densityNarrative = `Your citation density is appropriate for a paper of this length — ${uniqueCount} unique source${uniqueCount !== 1 ? 's' : ''} with ${inTextCount} in-text reference${inTextCount !== 1 ? 's' : ''} across ${wordCount} words. This suggests claims are being supported at a reasonable rate.`;
  }

  // Format
  let formatNarrative;
  if (detectedFormat === 'unknown' || uniqueCount === 0) {
    formatNarrative = 'No citation format could be reliably detected. All disciplines require a consistent citation style. Check with your institution or journal whether APA, IEEE, MLA, Chicago, or another format is required.';
  } else if (formatScore >= 90) {
    formatNarrative = `Your citations appear to consistently follow ${detectedFormat} format. Format consistency signals professional attention to detail and makes it easier for readers to locate sources. This is a strength of your paper.`;
  } else if (formatScore >= 75) {
    formatNarrative = `The dominant format appears to be ${detectedFormat}, but some inconsistencies were detected. Mixed citation styles (e.g., using both [1] IEEE brackets and (Author, Year) APA format) suggest the paper may have been assembled from multiple sources or drafts without a final citation audit.`;
  } else {
    formatNarrative = `Multiple citation formats appear to be mixed throughout the paper. This is a significant presentation issue. Even when the content is strong, inconsistent formatting signals a lack of editorial rigour. Use a reference manager (Zotero, Mendeley, or EndNote) to standardise all citations automatically.`;
  }

  // Reference list
  let refListNarrative;
  if (!hasRefSection) {
    refListNarrative = 'No reference section was detected. This is a critical omission. Without a reference list, readers cannot verify your sources, and the paper violates standard academic conventions in every discipline.';
  } else if (Math.abs(referencesListed - uniqueCount) > 3) {
    refListNarrative = `A mismatch was detected: approximately ${uniqueCount} unique in-text citation${uniqueCount !== 1 ? 's' : ''} versus ${referencesListed} entry/entries in the reference list. This can indicate orphaned references (listed but never cited) or missing references (cited in-text but absent from the list). Both are errors that require correction before submission.`;
  } else {
    refListNarrative = `Your reference list contains approximately ${referencesListed} entr${referencesListed !== 1 ? 'ies' : 'y'}, which appears broadly consistent with your in-text citation count (${uniqueCount} unique sources). Conduct a final cross-check to ensure every in-text citation has a corresponding reference entry.`;
  }

  return {
    summary: overall,
    densityAnalysis: densityNarrative,
    formatAnalysis: formatNarrative,
    referenceListAnalysis: refListNarrative,
    positives: buildCitationPositives(densityLabel, formatScore, hasRefSection),
    watchPoints: buildCitationWatchPoints(densityLabel, formatScore, hasRefSection, uniqueCount),
  };
}

function buildCitationPositives(densityLabel, formatScore, hasRefSection) {
  const p = [];
  if (densityLabel === 'good' || densityLabel === 'adequate') p.push('Citation density is appropriate for the paper length.');
  if (formatScore >= 85) p.push('Citation format is applied consistently throughout the document.');
  if (hasRefSection) p.push('A dedicated reference section is present.');
  return p.length ? p : ['Work towards building a well-cited, consistently formatted bibliography.'];
}

function buildCitationWatchPoints(densityLabel, formatScore, hasRefSection, uniqueCount) {
  const w = [];
  if (densityLabel === 'none') w.push('No citations detected — all claims are currently unsupported.');
  if (densityLabel === 'sparse') w.push('Citation density is too low — many claims may be unsubstantiated.');
  if (formatScore < 80) w.push('Mixed citation formats detected across the document.');
  if (!hasRefSection) w.push('No reference section found.');
  return w;
}

function buildCitationRecs(densityLabel, formatScore, hasRefSection, uniqueCount) {
  const recs = [];
  if (densityLabel === 'none') recs.push('Add in-text citations for every factual or theoretical claim that originates from prior work. Aim for at least one citation per major claim.');
  if (densityLabel === 'sparse') recs.push(`Add more citations — target at least one per paragraph for a paper of this length. Use Google Scholar, Semantic Scholar, or your library database to find relevant sources.`);
  if (formatScore < 80) recs.push('Standardise all citations to one format (APA, IEEE, or MLA). Use Zotero (free) to manage and auto-format references.');
  if (!hasRefSection) recs.push('Add a properly formatted reference section at the end of the document, listing every cited work in full.');
  if (!recs.length) recs.push('Conduct a final cross-check: verify every in-text citation has a corresponding reference entry and vice versa.');
  return recs;
}

// ════════════════════════════════════════════════════════════════════
// MODULE 3 — ARGUMENT STRENGTH ANALYSIS
// ════════════════════════════════════════════════════════════════════
function analyzeArguments(doc) {
  const lower    = doc.cleanedText.toLowerCase();
  const sentences = doc.sentences;

  const CLAIM_PHRASES    = ['this paper argues','we argue','we propose','we claim','this study proposes','we demonstrate','this work shows','this paper presents','we show that','the results indicate','the findings suggest','data shows','evidence indicates','this research demonstrates','our analysis reveals'];
  const EVIDENCE_PHRASES = ['according to','as shown in','as demonstrated by','as noted by','consistent with','in line with','supported by','as reported by','the data indicate','our results show','table','figure','chart'];
  const LOGICAL_CONNECTORS= ['therefore','consequently','thus','hence','as a result','it follows that','this implies','this means','accordingly'];
  const COUNTER_PHRASES  = ['however','although','despite','on the other hand','while','some researchers argue','critics argue','contrary to','it could be argued','one limitation','despite this','nevertheless','notwithstanding'];
  const HEDGE_PHRASES    = ['may','might','could','possibly','perhaps','it is possible','suggests','appears to','seems to','tends to'];

  const claimCount    = CLAIM_PHRASES.reduce((n, p) => n + occurrences(lower, p), 0);
  const evidenceCount = EVIDENCE_PHRASES.reduce((n, p) => n + occurrences(lower, p), 0);
  const connectorCount= LOGICAL_CONNECTORS.reduce((n, p) => n + occurrences(lower, p), 0);
  const counterCount  = COUNTER_PHRASES.reduce((n, p) => n + occurrences(lower, p), 0);
  const hedgeCount    = HEDGE_PHRASES.reduce((n, p) => n + occurrences(lower, p), 0);

  const hedgeRatio = sentences.length > 0 ? hedgeCount / sentences.length : 0;
  let hedgingBalance = 'appropriate';
  if (hedgeRatio > 0.5) hedgingBalance = 'over-hedged';
  else if (hedgeRatio < 0.05 && sentences.length > 20) hedgingBalance = 'under-hedged';

  const unsupportedCount = sentences.filter((s) => {
    const sl = s.toLowerCase();
    const hasClaim = CLAIM_PHRASES.some((p) => sl.includes(p));
    const hasEvid  = EVIDENCE_PHRASES.some((p) => sl.includes(p)) ||
                     /\([A-Z][a-zA-Z]+,\s*\d{4}\)/.test(s) || /\[\d+\]/.test(s);
    return hasClaim && !hasEvid;
  }).length;

  const evidenceRatio  = sentences.length > 0 ? evidenceCount / sentences.length : 0;
  const connectorDens  = sentences.length > 0 ? connectorCount / sentences.length : 0;
  const counterBonus   = Math.min(counterCount * 5, 20);
  const evidenceScore  = clamp(evidenceRatio * 400);
  const connectorScore = clamp(connectorDens * 800);
  const claimScore     = claimCount > 0 ? 80 : 40;
  const unsupportedPenalty = Math.min(unsupportedCount * 8, 40);

  const finalScore = clamp((evidenceScore * 0.35 + connectorScore * 0.25 + claimScore * 0.25 + counterBonus * 0.15) - unsupportedPenalty);

  const narrative = generateArgumentNarrative({
    score: finalScore, claimCount, evidenceCount, connectorCount,
    counterCount, unsupportedCount, hedgingBalance, hedgeCount,
    sentenceCount: sentences.length, evidenceRatio, connectorDens,
  });

  return {
    score: finalScore, grade: toGrade(finalScore),
    claimCount, evidenceCount, logicalConnectors: connectorCount,
    counterArgumentCount: counterCount, unsupportedClaims: unsupportedCount,
    hedgingBalance, narrative,
    recommendations: buildArgumentRecs(claimCount, evidenceCount, counterCount, unsupportedCount, hedgingBalance),
  };
}

function generateArgumentNarrative({ score, claimCount, evidenceCount, connectorCount, counterCount, unsupportedCount, hedgingBalance, hedgeCount, sentenceCount, evidenceRatio, connectorDens }) {
  let overall;
  if (score >= 85)      overall = 'Your paper demonstrates strong argumentative structure. Claims are consistently supported by evidence, and logical reasoning is clearly signposted throughout.';
  else if (score >= 70) overall = 'Your paper presents a reasonable argument, though some claims could be better supported and the logical structure could be made more explicit.';
  else if (score >= 50) overall = 'Your paper\'s argumentation needs strengthening. Several claims appear unsubstantiated, and the logical flow between ideas is not always clear.';
  else                  overall = 'Your paper\'s argumentative structure is weak. Claims, evidence, and logical reasoning are not sufficiently integrated to constitute a credible academic argument.';

  // Claim analysis
  let claimNarrative;
  if (claimCount === 0) {
    claimNarrative = 'No explicit thesis or claim statements were detected. Academic writing requires clear, explicit claims — statements like "This paper argues that...", "We propose that...", or "The evidence suggests that..." tell readers exactly what position your paper takes. Without these, your paper risks appearing descriptive rather than argumentative, which is insufficient for most academic contexts.';
  } else {
    claimNarrative = `${claimCount} explicit claim or thesis statement${claimCount !== 1 ? 's were' : ' was'} identified. This is positive — it shows you are making academic arguments rather than just describing. Ensure each claim is positioned clearly at the start of the paragraph it introduces, so readers immediately know what the paragraph will argue.`;
  }

  // Evidence analysis
  let evidenceNarrative;
  if (evidenceCount === 0) {
    evidenceNarrative = 'No evidence markers were detected (e.g., "according to", "as shown in", "the data indicates"). This is a serious concern. In academic writing, every significant claim must be backed by evidence — either data you collected, or citations from prior research. Without evidence, arguments are mere assertions.';
  } else if (evidenceRatio < 0.05) {
    evidenceNarrative = `Evidence markers appear infrequently (${evidenceCount} instances across ${sentenceCount} sentences). The ratio of claims to evidence is too low. A stronger paper would show explicit evidence for every substantive claim. Practice the "claim → evidence → analysis" sentence pattern: make a claim, provide evidence (with a citation), then explain what the evidence means.`;
  } else {
    evidenceNarrative = `Your paper shows ${evidenceCount} evidence markers across ${sentenceCount} sentences, suggesting a reasonable attempt to ground claims in evidence. Continue this practice and ensure that every major argument is explicitly supported, not just implied.`;
  }

  // Logical connectors
  let connectorNarrative;
  if (connectorDens < 0.03) {
    connectorNarrative = `Only ${connectorCount} logical conclusion marker${connectorCount !== 1 ? 's were' : ' was'} found (e.g., "therefore", "thus", "consequently"). These words are critical because they make your reasoning visible. Without them, readers must infer the logical connections you intend — and they may infer incorrectly. Adding connectors like "therefore", "this suggests", or "as a result" explicitly shows that your argument is building toward a conclusion.`;
  } else {
    connectorNarrative = `Your paper uses ${connectorCount} logical connectors, which is a good sign. These phrases make your reasoning transparent to the reader. Ensure they are used accurately — "therefore" signals a logical conclusion from prior evidence, "however" signals contrast, and "consequently" signals cause-and-effect.`;
  }

  // Counter-arguments
  let counterNarrative;
  if (counterCount === 0) {
    counterNarrative = 'No counter-argument acknowledgment was detected. This is a missed opportunity. Strong academic arguments engage with opposing views — not to agree with them, but to show why your argument is stronger. Phrases like "While some researchers argue [X], this paper contends that [Y] because [reason]" demonstrate academic maturity and strengthen your overall argument by addressing objections proactively.';
  } else {
    counterNarrative = `Your paper acknowledges counter-arguments or alternative views approximately ${counterCount} time${counterCount !== 1 ? 's' : ''}. This is excellent practice. Engaging with opposing perspectives shows intellectual rigour and significantly strengthens your argument. Ensure each counter-argument is followed by a clear rebuttal that explains why your position is better supported.`;
  }

  // Unsupported claims
  let unsupportedNarrative = '';
  if (unsupportedCount > 2) {
    unsupportedNarrative = `~${unsupportedCount} claim-making sentence${unsupportedCount !== 1 ? 's appear' : ' appears'} to lack adjacent evidence or citations. In academic writing, the burden of proof lies with the person making the claim. A useful heuristic: after writing any sentence that starts with "This shows...", "It is clear that...", or "Research proves...", immediately ask — "Where is my evidence?" If you cannot point to it, you need either a citation or a data reference.`;
  } else if (unsupportedCount > 0) {
    unsupportedNarrative = `${unsupportedCount} potentially unsupported claim${unsupportedCount !== 1 ? 's were' : ' was'} identified. Review these and ensure each has a corresponding citation or explicit data reference.`;
  }

  // Hedging
  let hedgingNarrative;
  if (hedgingBalance === 'over-hedged') {
    hedgingNarrative = `Your language is significantly hedged — words like "may", "might", "possibly", and "perhaps" appear frequently. Some hedging is appropriate in academic writing (especially when evidence is limited), but excessive hedging weakens your argument. If evidence strongly supports a claim, state it confidently: "The data indicate..." rather than "The data might possibly suggest..."`;
  } else if (hedgingBalance === 'under-hedged') {
    hedgingNarrative = 'Your paper makes very strong, unqualified assertions. Academic writing requires epistemic humility — acknowledge the limits of your evidence. Replace absolute language like "proves", "shows definitively", or "it is obvious" with more measured language: "suggests", "indicates", "is consistent with", or "is evidence for".';
  } else {
    hedgingNarrative = 'The balance between confident claims and appropriately hedged language appears reasonable. This is an important nuance in academic writing — too much hedging makes arguments seem weak, while overconfidence ignores the limits of evidence.';
  }

  return {
    summary: overall,
    claimAnalysis: claimNarrative,
    evidenceAnalysis: evidenceNarrative,
    logicAnalysis: connectorNarrative,
    counterArgumentAnalysis: counterNarrative,
    unsupportedClaimsAnalysis: unsupportedNarrative,
    hedgingAnalysis: hedgingNarrative,
    positives: buildArgumentPositives(claimCount, evidenceCount, counterCount, hedgingBalance),
    watchPoints: buildArgumentWatchPoints(claimCount, evidenceCount, counterCount, unsupportedCount),
  };
}

function buildArgumentPositives(claimCount, evidenceCount, counterCount, hedgingBalance) {
  const p = [];
  if (claimCount > 2) p.push(`${claimCount} explicit claim statements identified — your argument has clear positions.`);
  if (evidenceCount > 5) p.push('Evidence is cited to support arguments throughout the paper.');
  if (counterCount > 1) p.push('Counter-arguments are acknowledged, demonstrating academic maturity.');
  if (hedgingBalance === 'appropriate') p.push('Language confidence is well-calibrated — claims are neither over-qualified nor overstated.');
  return p.length ? p : ['Focus on building explicit claim-evidence-analysis structures in each paragraph.'];
}

function buildArgumentWatchPoints(claimCount, evidenceCount, counterCount, unsupportedCount) {
  const w = [];
  if (claimCount === 0) w.push('No clear thesis or claim statements detected.');
  if (evidenceCount < 3) w.push('Evidence markers are very sparse — claims appear largely unsupported.');
  if (counterCount === 0) w.push('No counter-arguments addressed — the argument appears one-sided.');
  if (unsupportedCount > 2) w.push(`~${unsupportedCount} claims appear to lack supporting evidence.`);
  return w;
}

function buildArgumentRecs(claimCount, evidenceCount, counterCount, unsupportedCount, hedgingBalance) {
  const recs = [];
  if (claimCount === 0) recs.push('Add explicit thesis statements: begin your argument sections with "This paper argues that..." or "We propose that..."');
  if (evidenceCount < 3) recs.push('Apply the Claim–Evidence–Analysis pattern in every paragraph: (1) state your claim, (2) provide evidence with a citation, (3) explain what the evidence means for your argument.');
  if (counterCount === 0) recs.push('Address at least 2–3 counter-arguments. Use the structure: "While some argue [X], this paper contends [Y] because [evidence]."');
  if (unsupportedCount > 2) recs.push(`Review the ~${unsupportedCount} unsupported claim(s) and add citations or data to each.`);
  if (hedgingBalance === 'over-hedged') recs.push('Reduce excessive hedging — use "the data indicate" instead of "the data might possibly suggest".');
  if (hedgingBalance === 'under-hedged') recs.push('Add appropriate epistemic qualifiers: "suggests", "indicates", "is consistent with" rather than "proves".');
  if (!recs.length) recs.push('Maintain strong argumentation practices. Ensure every major claim has visible evidence and explicit reasoning.');
  return recs;
}

// ════════════════════════════════════════════════════════════════════
// MODULE 4 — INTEGRITY RISK INDICATORS
// ════════════════════════════════════════════════════════════════════
function analyzeIntegrity(doc, citationResult) {
  const text  = doc.cleanedText;
  const lower = text.toLowerCase();
  const risks = [];

  if (!doc.sections.present['methodology']) {
    risks.push({ type: 'missing_methodology', severity: 'high', category: 'Reproducibility',
      detail: 'No methodology section was found.',
      explanation: 'Without a methodology, other researchers cannot replicate your study, and reviewers cannot assess whether your results are valid. This raises a fundamental question about research credibility: if the method is not described, how can the results be trusted? This is considered a serious integrity concern in peer review.',
      resolution: 'Add a full methodology section describing: (1) research design, (2) data source/sample, (3) data collection method, (4) analysis approach, and (5) ethical considerations.' });
  }

  if (!doc.sections.present['references']) {
    risks.push({ type: 'missing_references', severity: 'high', category: 'Attribution',
      detail: 'No reference section was detected.',
      explanation: 'A paper without a reference list cannot give credit to prior work it has drawn upon. This has two consequences: it constitutes potential academic plagiarism (using ideas without attribution), and it makes all factual claims unverifiable.',
      resolution: 'Add a complete reference section. Every idea, finding, or argument you borrowed from prior work must be credited.' });
  }

  const STAT_PATTERNS = [/\d{1,3}(?:\.\d+)?%/g, /\d+\s+(?:out of|of)\s+\d+/g, /p\s*[<=>]\s*0\.\d+/g, /r\s*=\s*[-]?\d+\.\d+/g];
  const statMatches = STAT_PATTERNS.flatMap((p) => [...text.matchAll(p)]);
  const unsupportedStats = statMatches.filter((m) => {
    const ctx = text.slice(Math.max(0, m.index - 120), m.index + 120);
    return !/\([A-Z][a-zA-Z]+,\s*\d{4}\)|\[\d+\]|table|figure|appendix/i.test(ctx);
  });
  if (unsupportedStats.length > 2) {
    risks.push({ type: 'unsupported_statistics', severity: 'medium', category: 'Evidence Quality',
      detail: `${unsupportedStats.length} statistical value(s) detected without an adjacent citation or table reference.`,
      explanation: `Statistics carry significant persuasive weight in academic writing, which is precisely why they require attribution. Citing a percentage or correlation without a source — such as writing "57% of students fail" without a reference — is a form of fabrication if the number was not derived from your own data. Even when statistics come from your own analysis, they should be anchored to a table or figure.`,
      resolution: 'For each statistic: if it comes from prior research, add the citation immediately; if it comes from your own data, reference the specific table or figure.' });
  }

  const VAGUE_PHRASES = ['studies show','research indicates','experts agree','it is widely known','it is commonly accepted','many researchers believe','scientists say','it is well established'];
  const vagueCount = VAGUE_PHRASES.reduce((n, p) => n + occurrences(lower, p), 0);
  if (vagueCount > 2) {
    risks.push({ type: 'vague_authority', severity: 'medium', category: 'Citation Quality',
      detail: `${vagueCount} vague authority claim(s) detected (e.g., "studies show", "research indicates") without specific citations.`,
      explanation: '"Studies show" and "research indicates" are arguably the most common academic writing errors. They appeal to a vague, unnamed consensus rather than specific, verifiable research. In peer review, these phrases trigger immediate scepticism: which studies? Which researchers? When you cannot name a source, you are making an assertion that has no verifiable basis.',
      resolution: 'Replace every instance of "studies show" or "research indicates" with a specific citation: "Smith and Jones (2022) found that..." or "A meta-analysis of 45 studies (Garcia, 2021) indicates..."' });
  }

  const dupeCount = countNearDuplicates(doc.sentences);
  if (dupeCount > 3) {
    risks.push({ type: 'repetitive_content', severity: 'medium', category: 'Content Quality',
      detail: `~${dupeCount} sentence pair(s) appear highly similar, suggesting repeated content or padding.`,
      explanation: 'Repetitive sentences can indicate two problems: (1) content padding to reach word count requirements, which reviewers readily detect, or (2) accidental copy-paste within the document. Either way, it weakens the paper. Academic writing should be economical — every sentence should contribute new information or analysis.',
      resolution: 'Identify and eliminate near-duplicate sentences. If the same point is made in multiple places, merge them into one location where it has the most impact.' });
  }

  if (doc.wordCount > 1500 && citationResult.uniqueCitations < 5) {
    risks.push({ type: 'citation_gap', severity: 'high', category: 'Academic Integrity',
      detail: `Only ${citationResult.uniqueCitations} unique citation(s) in a ${doc.wordCount}-word paper — significant under-citation.`,
      explanation: `A ${doc.wordCount}-word academic paper with fewer than 5 citations almost certainly contains many claims that are based on prior knowledge but not attributed. This can constitute unintentional plagiarism — using ideas, frameworks, or arguments from the literature without giving credit. It also makes the paper impossible to position within existing scholarship.`,
      resolution: 'Conduct a comprehensive literature search. For a paper of this length, aim for a minimum of 15–20 sources from peer-reviewed journals or books.' });
  }

  if (doc.sections.present['methodology']) {
    const methWords = (doc.sections.found['methodology'] || '').split(/\s+/).filter(Boolean).length;
    if (methWords < 100 && doc.wordCount > 1500) {
      risks.push({ type: 'thin_methodology', severity: 'medium', category: 'Reproducibility',
        detail: `Methodology section is only ~${methWords} words — too brief for replication.`,
        explanation: 'A methodology section of fewer than 100 words raises serious questions about transparency. Reproducibility is a cornerstone of scientific integrity: if another researcher cannot follow your methodology, your results cannot be independently verified. Short methodology sections often omit critical details about sample selection, data collection procedures, or analytical choices — all of which can introduce undetected bias.',
        resolution: 'Expand the methodology to at least 300–500 words. Describe your research design, sample (who/what/how many), data collection procedure, analytical framework, and any limitations or biases you controlled for.' });
    }
  }

  const highRisks = risks.filter((r) => r.severity === 'high').length;
  const medRisks  = risks.filter((r) => r.severity === 'medium').length;
  const riskScore = Math.max(0, 100 - highRisks * 20 - medRisks * 8);
  const riskLevel = riskScore >= 80 ? 'low' : riskScore >= 55 ? 'moderate' : 'high';

  const narrative = generateIntegrityNarrative({ score: riskScore, riskLevel, risks, highRisks, medRisks, wordCount: doc.wordCount });

  return {
    score: clamp(riskScore), grade: toGrade(clamp(riskScore)),
    riskLevel, riskCount: risks.length, highRisks, mediumRisks: medRisks,
    risks, narrative,
    recommendations: risks.length ? risks.map((r) => r.resolution) : ['No significant integrity concerns detected. Maintain current research and citation standards.'],
  };
}

function generateIntegrityNarrative({ score, riskLevel, risks, highRisks, medRisks, wordCount }) {
  let overall;
  if (riskLevel === 'low')      overall = 'No major academic integrity concerns were detected. The paper demonstrates responsible research and citation practice.';
  else if (riskLevel === 'moderate') overall = `${risks.length} integrity concern${risks.length !== 1 ? 's were' : ' was'} identified. While not necessarily indicating intentional misconduct, these issues must be addressed to meet academic publication standards.`;
  else overall = `${highRisks} critical integrity issue${highRisks !== 1 ? 's' : ''} were identified. These represent serious academic integrity concerns that, if unaddressed, could result in rejection, required revision, or formal integrity proceedings.`;

  const context = 'Academic integrity encompasses honesty, transparency, and proper attribution throughout the research process. ELEV flags potential risks based on structural and textual indicators — these are not accusations of misconduct, but rather signals that require your attention before submission.';

  let riskExplanation = '';
  if (risks.length === 0) {
    riskExplanation = 'The automated analysis detected no major structural integrity risks. However, note that automated analysis cannot detect all forms of integrity concern — for example, fabricated data or paraphrased plagiarism that is semantically distinct from the original. Always conduct a self-audit before submission.';
  } else {
    const categories = [...new Set(risks.map((r) => r.category))];
    riskExplanation = `Concerns were found in the following area${categories.length !== 1 ? 's' : ''}: ${categories.join(', ')}. Each issue is explained in detail below with specific resolution guidance.`;
  }

  let preventionAdvice;
  if (riskLevel === 'high') {
    preventionAdvice = 'Before resubmitting this paper, we strongly recommend: (1) reading your institution\'s academic integrity policy, (2) running the revised paper through a plagiarism detection tool (Turnitin, iThenticate), (3) having a supervisor or peer review the methodology and citation sections.';
  } else if (riskLevel === 'moderate') {
    preventionAdvice = 'Address each flagged item systematically before submission. The most impactful changes will be: replacing vague authority claims with specific citations, and ensuring all statistics are attributed.';
  } else {
    preventionAdvice = 'Continue applying careful attribution and transparent methodology. Conduct a final self-check before submission: read each paragraph and ask "Is every claim here supported by evidence or my own clearly described data?"';
  }

  return {
    summary: overall,
    context,
    riskExplanation,
    preventionAdvice,
    positives: score >= 70 ? ['No critical attribution or transparency issues detected.', 'Research methodology appears to be reported (where present).'] : [],
    watchPoints: risks.map((r) => `${r.category}: ${r.detail}`),
  };
}

function countNearDuplicates(sentences) {
  let dupes = 0;
  for (let i = 0; i < Math.min(sentences.length, 100); i++) {
    for (let j = i + 1; j < Math.min(sentences.length, 100); j++) {
      if (jaccardSimilarity(sentences[i], sentences[j]) > 0.72) dupes++;
    }
  }
  return dupes;
}

function jaccardSimilarity(a, b) {
  const setA = new Set(a.toLowerCase().split(/\s+/));
  const setB = new Set(b.toLowerCase().split(/\s+/));
  if (!setA.size || !setB.size) return 0;
  const intersection = [...setA].filter((w) => setB.has(w)).length;
  return intersection / new Set([...setA, ...setB]).size;
}

function generateIntegrityRecs(risks) {
  if (!risks.length) return ['No significant integrity concerns detected. Maintain current research and citation standards.'];
  return risks.map((r) => r.resolution);
}

// ════════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ════════════════════════════════════════════════════════════════════
function runFullAnalysis(parsedDoc) {
  const structural = analyzeStructure(parsedDoc);
  const citation   = analyzeCitations(parsedDoc);
  const argument   = analyzeArguments(parsedDoc);
  const integrity  = analyzeIntegrity(parsedDoc, citation);

  const elevScore = clamp(
    structural.score * 0.30 +
    citation.score   * 0.25 +
    argument.score   * 0.25 +
    integrity.score  * 0.20
  );

  // Overall paper narrative
  const overallNarrative = generateOverallNarrative(elevScore, structural, citation, argument, integrity);

  return {
    elevScore, grade: toGrade(elevScore),
    processedAt: new Date().toISOString(),
    document: {
      title: parsedDoc.metadata.title,
      wordCount: parsedDoc.wordCount,
      pageCount: parsedDoc.pageCount,
      citationFormat: parsedDoc.metadata.citationFormat,
    },
    overallNarrative,
    structural, citation, argument, integrity,
  };
}

function generateOverallNarrative(score, structural, citation, argument, integrity) {
  if (score >= 85) return `Your paper demonstrates strong academic quality across all four ELEV dimensions. It is well-structured, appropriately cited, logically argued, and presents no major integrity concerns. Review the module-specific recommendations to refine and strengthen it further before submission.`;
  if (score >= 70) return `Your paper shows solid academic potential. The strongest areas are ${findStrengths([structural, citation, argument, integrity])}. Focus revision efforts on ${findWeaknesses([structural, citation, argument, integrity])}, where targeted improvements will have the greatest impact on your ELEV score and academic credibility.`;
  if (score >= 55) return `Your paper needs significant revision before it would be accepted for academic publication. Key issues span ${countIssueModules([structural, citation, argument, integrity])} of the four evaluation dimensions. Prioritise structural completeness and citation quality first, as these form the foundation on which argument strength and integrity assessments depend.`;
  return `Your paper requires substantial work before it meets academic publication standards. Critical deficiencies were identified across multiple dimensions. Begin with the highest-severity issues flagged in the Integrity and Structure modules, then address citations before refining your argument.`;
}

function findStrengths(modules) {
  const names = ['structural', 'citation', 'argument', 'integrity'];
  const strong = modules.map((m, i) => ({ name: names[i], score: m.score })).filter((m) => m.score >= 75).map((m) => m.name);
  return strong.length ? strong.join(' and ') : 'the analysed dimensions';
}

function findWeaknesses(modules) {
  const names = ['structural organisation', 'citation quality', 'argument strength', 'integrity indicators'];
  const weak = modules.map((m, i) => ({ name: names[i], score: m.score })).filter((m) => m.score < 65).map((m) => m.name);
  return weak.length ? weak.join(' and ') : 'all modules equally';
}

function countIssueModules(modules) {
  return modules.filter((m) => m.score < 65).length;
}

module.exports = { runFullAnalysis };
