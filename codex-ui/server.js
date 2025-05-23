const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process'); // Added child_process

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// In-memory store for API key and project directory
let storedApiKey = null;
let storedProjectDirectory = null;

// Helper function to load config from .env.mock if in-memory is null
const loadConfigFromMock = () => {
  if (storedApiKey === null || storedProjectDirectory === null) {
    try {
      const envPath = path.join(__dirname, '.env.mock');
      if (fs.existsSync(envPath)) {
        const envContents = fs.readFileSync(envPath, 'utf8');
        if (storedApiKey === null) {
            const apiKeyMatch = envContents.match(/^API_KEY=(.*)$/m);
            if (apiKeyMatch && apiKeyMatch[1]) storedApiKey = apiKeyMatch[1];
        }
        if (storedProjectDirectory === null) {
            const projectDirMatch = envContents.match(/^PROJECT_DIR=(.*)$/m);
            if (projectDirMatch && projectDirMatch[1]) storedProjectDirectory = projectDirMatch[1];
        }
      }
    } catch (error) {
      console.warn('Could not load .env.mock:', error.message);
    }
  }
};


// API Endpoints

// API Key Management
app.post('/api/config/apikey', (req, res) => {
  const { apiKey } = req.body;
  if (typeof apiKey === 'string') {
    storedApiKey = apiKey;
    try {
      fs.writeFileSync(path.join(__dirname, '.env.mock'), `API_KEY=${apiKey}\nPROJECT_DIR=${storedProjectDirectory || ''}`);
      res.send({ message: 'API key stored successfully.' });
    } catch (error) {
      console.error('Failed to write to .env.mock:', error);
      res.status(500).send({ error: 'Failed to store API key due to backend error.' });
    }
  } else {
    res.status(400).send({ error: 'Invalid API key provided. Expecting { apiKey: "YOUR_API_KEY" }' });
  }
});

app.get('/api/config/apikey', (req, res) => {
  loadConfigFromMock(); // Ensure config is loaded if available
  res.send({ apiKey: storedApiKey });
});

// Project Directory Management
app.post('/api/config/projectdir', (req, res) => {
  const { projectDirectory } = req.body;
  if (typeof projectDirectory === 'string') {
    storedProjectDirectory = projectDirectory;
     try {
      fs.writeFileSync(path.join(__dirname, '.env.mock'), `API_KEY=${storedApiKey || ''}\nPROJECT_DIR=${projectDirectory}`);
      res.send({ message: 'Project directory stored successfully.' });
    } catch (error) {
      console.error('Failed to write to .env.mock:', error);
      res.status(500).send({ error: 'Failed to store project directory due to backend error.' });
    }
  } else {
    res.status(400).send({ error: 'Invalid project directory provided. Expecting { projectDirectory: "/path/to/project" }' });
  }
});

app.get('/api/config/projectdir', (req, res) => {
  loadConfigFromMock(); // Ensure config is loaded if available
  res.send({ projectDirectory: storedProjectDirectory });
});

// Agents File Management
app.get('/api/agents', (req, res) => {
  loadConfigFromMock(); // Ensure project directory is loaded if available
  if (!storedProjectDirectory) {
    return res.status(400).send({ error: 'Project Directory not configured. Please configure it first.' });
  }

  const filePathQueryParam = req.query.filePath || 'AGENTS.md';
  const fullPath = path.join(storedProjectDirectory, filePathQueryParam);
  const resolvedFullPath = path.resolve(fullPath);
  const resolvedProjectDir = path.resolve(storedProjectDirectory);

  if (!resolvedFullPath.startsWith(resolvedProjectDir)) {
    return res.status(403).send({ error: 'Access denied: filePath is outside the project directory.' });
  }

  try {
    const content = fs.readFileSync(fullPath, 'utf8');
    res.send({ content, path: filePathQueryParam }); // Send back the path that was read
  } catch (error) {
    console.error(`Error reading file at ${fullPath}:`, error);
    if (error.code === 'ENOENT') {
        res.status(404).send({ error: `File not found at specified path: ${filePathQueryParam}`, details: error.message });
    } else {
        res.status(500).send({ error: 'Could not read file.', details: error.message });
    }
  }
});

app.post('/api/agents', (req, res) => {
  loadConfigFromMock(); // Ensure project directory is loaded if available
  if (!storedProjectDirectory) {
    return res.status(400).send({ error: 'Project Directory not configured. Please configure it first.' });
  }

  const { content } = req.body;
  const pathFromBody = req.body.path || 'AGENTS.md'; // path is now expected in body

  if (typeof content !== 'string') {
    return res.status(400).send({ error: 'Invalid content provided. Expecting { path: "your/file.md", content: "NEW_CONTENT" }' });
  }
  if (typeof pathFromBody !== 'string') {
    return res.status(400).send({ error: 'Invalid file path provided. Expecting { path: "your/file.md", content: "..." }' });
  }


  const fullPath = path.join(storedProjectDirectory, pathFromBody);
  const resolvedFullPath = path.resolve(fullPath);
  const resolvedProjectDir = path.resolve(storedProjectDirectory);

  if (!resolvedFullPath.startsWith(resolvedProjectDir)) {
    return res.status(403).send({ error: 'Access denied: filePath is outside the project directory.' });
  }

  try {
    // Ensure directory exists before writing
    const dirName = path.dirname(fullPath);
    if (!fs.existsSync(dirName)) {
        fs.mkdirSync(dirName, { recursive: true });
    }
    fs.writeFileSync(fullPath, content, 'utf8');
    res.send({ message: `File '${pathFromBody}' updated successfully.` });
  } catch (error) {
    console.error(`Error writing to file at ${fullPath}:`, error);
    res.status(500).send({ error: `Failed to update file '${pathFromBody}'.`, details: error.message });
  }
});

// Codex CLI Execution
app.post('/api/codex/execute', (req, res) => {
  const { prompt, options } = req.body;

  loadConfigFromMock(); // Ensure latest config is loaded if not in memory

  if (!prompt) {
    return res.status(400).send({ error: 'Prompt is required.' });
  }
  if (!storedApiKey) {
    return res.status(400).send({ error: 'API Key not configured. Please configure it first.' });
  }
  if (!storedProjectDirectory) {
    return res.status(400).send({ error: 'Project Directory not configured. Please configure it first.' });
  }
  if (!fs.existsSync(storedProjectDirectory) || !fs.lstatSync(storedProjectDirectory).isDirectory()) {
    return res.status(400).send({ error: `Project directory "${storedProjectDirectory}" does not exist or is not a directory.`});
  }

  const escapedPrompt = prompt.replace(/"/g, '\\"');
  let command = `codex "${escapedPrompt}"`;

  if (options && options.model) {
    const escapedModel = options.model.replace(/"/g, '\\"');
    command += ` --model "${escapedModel}"`;
  }

  if (options && options.mode) {
    let approvalMode = options.mode;
    if (approvalMode === 'interactive') {
      approvalMode = 'suggest'; 
    }
    command += ` --approval-mode ${approvalMode}`;
  }
  
  command += ` --quiet`;

  console.log(`Executing command: ${command}`);
  console.log(`In directory: ${storedProjectDirectory}`);
  console.log(`With API Key: ${storedApiKey ? '*********' : 'Not Set'}`);

  exec(command, {
    env: { ...process.env, 'OPENAI_API_KEY': storedApiKey },
    cwd: storedProjectDirectory
  }, (error, stdout, stderr) => {
    if (error) {
      console.error(`Codex execution error: ${error.message}`);
      return res.status(500).send({ 
        status: "error", 
        message: `Codex command failed with exit code ${error.code}.`, 
        error: error.message,
        stdout: stdout, 
        stderr: stderr 
      });
    }
    res.send({ 
      status: "success", 
      stdout: stdout, 
      stderr: stderr 
    });
  });
});

app.get('/api/hello', (req, res) => {
  res.send({ message: 'Hello from the backend!' });
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}.`);
});
