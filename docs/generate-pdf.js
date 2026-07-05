const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { marked } = require('marked');

// Configure marked to render code blocks and tables properly
marked.setOptions({
  gfm: true,
  breaks: true,
});

const WORKSPACE_DIR = path.dirname(__dirname);
const BRAIN_DIR = 'C:\\Users\\mjais\\.gemini\\antigravity-ide\\brain\\fbe805b7-03eb-475a-8f4c-780485414074';
const OUTPUT_PDF = path.join(WORKSPACE_DIR, 'RA2311028020008.pdf');
const TEMP_HTML = path.join(WORKSPACE_DIR, 'temp_report.html');

console.log('Starting PDF Generation Script...');
console.log('Workspace directory:', WORKSPACE_DIR);
console.log('Output PDF target:', OUTPUT_PDF);

// Helper to read file content safely
function readFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    console.error(`Error reading ${filePath}:`, err.message);
    return `*Error reading file: ${path.basename(filePath)}*`;
  }
}

// Helper to convert image to base64
function getBase64Image(fileName) {
  const filePath = path.join(BRAIN_DIR, fileName);
  try {
    const fileBuffer = fs.readFileSync(filePath);
    return `data:image/png;base64,${fileBuffer.toString('base64')}`;
  } catch (err) {
    console.error(`Error reading image ${fileName}:`, err.message);
    return '';
  }
}

// Read markdown files
const readmeMd = readFile(path.join(WORKSPACE_DIR, 'README.md'));
const setupMd = readFile(path.join(WORKSPACE_DIR, 'docs', 'README.md'));
const archMd = readFile(path.join(WORKSPACE_DIR, 'docs', 'architecture.md'));
const erMd = readFile(path.join(WORKSPACE_DIR, 'docs', 'er-diagram.md'));
const decisionsMd = readFile(path.join(WORKSPACE_DIR, 'docs', 'design-decisions.md'));
const apiMd = readFile(path.join(WORKSPACE_DIR, 'docs', 'api.md'));

// Embed screenshots
const loginBase64 = getBase64Image('login_page_1783250958978.png');
const overviewBase64 = getBase64Image('overview_page_1783250975522.png');
const jobsBase64 = getBase64Image('jobs_page_1783250996546.png');
const dlqBase64 = getBase64Image('dead_letters_page_1783251012466.png');

// Compile full report HTML content
const coverHtml = `
  <div class="cover-page">
    <div class="cover-brand">
      <span class="cover-brand-icon"></span>
      <span class="cover-brand-text">RELAY</span>
    </div>
    <h1 class="cover-title">Relay: Distributed Background Job Infrastructure Platform</h1>
    <h2 class="cover-subtitle">A Production-Grade Async Task Orchestration Platform</h2>
    
    <div class="cover-divider"></div>
    
    <div class="cover-meta">
      <div class="meta-row"><span class="meta-label">Assignment:</span> <span class="meta-val">Codity.AI Tech Assignment</span></div>
      <div class="meta-row"><span class="meta-label">Candidate Name:</span> <span class="meta-val">M Jaisurya</span></div>
      <div class="meta-row"><span class="meta-label">Registration Number:</span> <span class="meta-val">RA2311028020008</span></div>
      <div class="meta-row"><span class="meta-label">Institution:</span> <span class="meta-val">SRM Institute of Science and Technology</span></div>
      <div class="meta-row"><span class="meta-label">Submission Date:</span> <span class="meta-val">${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</span></div>
    </div>
  </div>
`;

const bodyHtml = `
  <div class="page-break"></div>
  
  <div class="section">
    <h1>1. Executive Summary & Quick Start</h1>
    ${marked(readmeMd)}
  </div>
  
  <div class="page-break"></div>
  
  <div class="section">
    <h1>2. System Architecture & Component Design</h1>
    ${marked(archMd)}
  </div>
  
  <div class="page-break"></div>
  
  <div class="section">
    <h1>3. Relational Database Design & Schema</h1>
    ${marked(erMd)}
  </div>
  
  <div class="page-break"></div>
  
  <div class="section">
    <h1>4. Engineering Design Decisions & Trade-offs</h1>
    ${marked(decisionsMd)}
  </div>
  
  <div class="page-break"></div>
  
  <div class="section">
    <h1>5. REST API Documentation & Handlers</h1>
    ${marked(apiMd)}
  </div>
  
  <div class="page-break"></div>
  
  <div class="section">
    <h1>6. Verified Live Execution & Dashboard Screenshots</h1>
    <p>This section presents visual verification of the operational Relay platform. The frontend features a custom, high-fidelity dark console showcasing real-time queue states, active worker loads, transactional history lists, and Dead-Letter Queue (DLQ) forensic inspection tools.</p>
    
    <h2>6.1 Premium Portal Login Screen</h2>
    <p>The workspace authentication interface featuring JWT session generation, password toggling, and client form validation.</p>
    <img src="${loginBase64}" class="screenshot" alt="Relay Portal Login" />
    
    <div class="page-break"></div>
    
    <h2>6.2 Overview Dashboard (System Health, Load & Metrics)</h2>
    <p>The operational controller screen showing standard queue breakdown status bars, memory footprint, and cluster connection indicators.</p>
    <img src="${overviewBase64}" class="screenshot" alt="Relay Overview Console" />
    
    <div class="page-break"></div>
    
    <h2>6.3 Job Registry (Dynamic Tracing & In-Place Inspections)</h2>
    <p>Active listing of completed and failed jobs with pagination controls, state filter drop-downs, and inline error tracing.</p>
    <img src="${jobsBase64}" class="screenshot" alt="Relay Job Explorer" />
    
    <div class="page-break"></div>
    
    <h2>6.4 Dead-Letter Queue & Retries Manager</h2>
    <p>Targeted failure queue exposing original immutable payload states and failure causes, equipped with operational manual retries.</p>
    <img src="${dlqBase64}" class="screenshot" alt="Relay DLQ Console" />
  </div>

  <div class="page-break"></div>

  <div class="section">
    <h1>7. Comprehensive Platform Installation & Setup Guide</h1>
    ${marked(setupMd)}
  </div>
`;

const htmlTemplate = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>RA2311028020008 - Relay Assignment Report</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap');
    
    :root {
      --primary: #7C3AED;
      --primary-dark: #6D28D9;
      --text: #1F2937;
      --text-muted: #4B5563;
      --border: #E5E7EB;
      --bg-light: #F9FAFB;
    }
    
    body {
      font-family: 'Inter', sans-serif;
      color: var(--text);
      line-height: 1.6;
      margin: 0;
      padding: 0;
      font-size: 14px;
    }
    
    /* Cover Page styling */
    .cover-page {
      height: 98vh;
      display: flex;
      flex-direction: column;
      justify-content: center;
      padding: 80px;
      box-sizing: border-box;
      background: linear-gradient(135deg, #FAF8FF 0%, #FFFFFF 100%);
      position: relative;
    }
    
    .cover-brand {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 40px;
    }
    
    .cover-brand-icon {
      width: 44px;
      height: 44px;
      background: linear-gradient(135deg, var(--primary) 0%, #4F46E5 100%);
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: white;
      font-size: 22px;
      font-weight: bold;
    }
    
    .cover-brand-text {
      font-size: 20px;
      font-weight: 800;
      letter-spacing: 0.05em;
      color: #111827;
    }
    
    .cover-title {
      font-size: 40px;
      font-weight: 800;
      line-height: 1.2;
      color: #111827;
      margin: 0 0 16px 0;
      letter-spacing: -0.02em;
    }
    
    .cover-subtitle {
      font-size: 20px;
      font-weight: 400;
      color: var(--text-muted);
      margin: 0;
      letter-spacing: -0.01em;
    }
    
    .cover-divider {
      height: 4px;
      width: 120px;
      background: var(--primary);
      margin: 48px 0;
      border-radius: 99px;
    }
    
    .cover-meta {
      display: flex;
      flex-direction: column;
      gap: 12px;
      font-size: 15px;
    }
    
    .meta-row {
      display: flex;
    }
    
    .meta-label {
      font-weight: 600;
      color: var(--text-muted);
      width: 200px;
    }
    
    .meta-val {
      color: #111827;
    }
    
    /* Layout & Content Section */
    .section {
      padding: 60px 80px;
      box-sizing: border-box;
    }
    
    h1, h2, h3, h4 {
      color: #111827;
      font-weight: 700;
      letter-spacing: -0.01em;
    }
    
    h1 {
      font-size: 24px;
      border-bottom: 2px solid var(--border);
      padding-bottom: 12px;
      margin-top: 0;
      margin-bottom: 24px;
      color: var(--primary);
    }
    
    h2 {
      font-size: 18px;
      margin-top: 32px;
      margin-bottom: 16px;
    }
    
    h3 {
      font-size: 15px;
      margin-top: 24px;
      margin-bottom: 12px;
    }
    
    p {
      margin-top: 0;
      margin-bottom: 16px;
    }
    
    /* Table styles */
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 20px 0;
    }
    
    th, td {
      border: 1px solid var(--border);
      padding: 10px 14px;
      text-align: left;
      font-size: 13px;
    }
    
    th {
      background-color: var(--bg-light);
      font-weight: 600;
    }
    
    /* Code block styling */
    pre, code {
      font-family: 'JetBrains Mono', monospace;
      background-color: var(--bg-light);
      border-radius: 6px;
    }
    
    code {
      font-size: 12.5px;
      padding: 3px 6px;
      border: 1px solid var(--border);
    }
    
    pre {
      padding: 16px;
      overflow-x: auto;
      border: 1px solid var(--border);
      margin: 18px 0;
    }
    
    pre code {
      padding: 0;
      font-size: 12px;
      background-color: transparent;
      border: none;
    }
    
    /* Page break control */
    .page-break {
      page-break-before: always;
      break-before: page;
    }
    
    /* Screenshot image layout */
    .screenshot {
      display: block;
      width: 100%;
      max-width: 900px;
      height: auto;
      border: 1px solid var(--border);
      border-radius: 8px;
      margin: 20px 0;
      box-shadow: 0 4px 12px rgba(0,0,0,0.05);
    }
    
    /* Bullet lists */
    ul, ol {
      margin-top: 0;
      margin-bottom: 16px;
      padding-left: 24px;
    }
    
    li {
      margin-bottom: 6px;
    }
  </style>
</head>
<body>
  ${coverHtml}
  ${bodyHtml}
</body>
</html>
`;

// Save the combined HTML file
fs.writeFileSync(TEMP_HTML, htmlTemplate, 'utf-8');
console.log('Merged HTML report created successfully at:', TEMP_HTML);

// Execute Edge headless print to generate PDF
console.log('Generating PDF using Microsoft Edge headless engine...');
const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

try {
  execSync(`& "${edgePath}" --headless --disable-gpu --print-to-pdf="${OUTPUT_PDF}" "${TEMP_HTML}"`, {
    shell: 'powershell.exe',
    stdio: 'inherit'
  });
  console.log('Success! PDF created successfully at:', OUTPUT_PDF);
  
  // Cleanup temp HTML file
  fs.unlinkSync(TEMP_HTML);
  console.log('Cleaned up temporary HTML report.');
} catch (err) {
  console.error('Error generating PDF via Edge:', err.message);
  process.exit(1);
}
