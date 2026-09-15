-- ==================== DATABASE SCHEMA ====================
-- Meta-Harness: Local AI Orchestration System
-- PostgreSQL schema

-- ==================== COMPUTERS ====================

CREATE TABLE computers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('workstation', 'server', 'laptop')),
  status TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'offline')),
  
  -- OS info
  os_platform TEXT,
  os_architecture TEXT,
  os_version TEXT,
  
  -- Hardware
  cpu TEXT,
  memory_gb INTEGER,
  
  -- GPU
  gpu_vendor TEXT CHECK (gpu_vendor IN ('apple', 'nvidia', 'amd', 'intel')),
  gpu_model TEXT,
  gpu_memory_gb INTEGER,
  unified_memory BOOLEAN DEFAULT FALSE,
  cuda_enabled BOOLEAN DEFAULT FALSE,
  
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- ==================== RESOURCE STATE (latest snapshot) ====================

CREATE TABLE computer_resource_state (
  id SERIAL PRIMARY KEY,
  computer_id TEXT REFERENCES computers(id),
  cpu_percent DECIMAL(5, 2),
  memory_used_gb INTEGER,
  memory_available_gb INTEGER,
  gpu_utilization_percent DECIMAL(5, 2),
  gpu_memory_used_gb INTEGER,
  gpu_memory_available_gb INTEGER,
  captured_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- ==================== RUNTIMES ====================

CREATE TABLE runtimes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT,
  status TEXT CHECK (status IN ('healthy', 'degraded', 'unavailable')),
  computer_id TEXT REFERENCES computers(id),
  installed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ==================== MODELS ====================

CREATE TABLE models (
  id TEXT PRIMARY KEY,
  runtime_id TEXT NOT NULL REFERENCES runtimes(id) ON DELETE CASCADE,
  runtime_model_id TEXT NOT NULL,
  name TEXT,
  family TEXT,
  parameters TEXT,
  context_window INTEGER NOT NULL,
  quantization TEXT,
  
  -- Capabilities (stored as JSON)
  capabilities JSONB NOT NULL DEFAULT '[]',
  
  vision BOOLEAN NOT NULL DEFAULT FALSE,
  embedding BOOLEAN NOT NULL DEFAULT FALSE,
  local BOOLEAN NOT NULL DEFAULT TRUE,
  loaded BOOLEAN NOT NULL DEFAULT FALSE,
  
  discovered_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  last_updated TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- ==================== TASKS ====================

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  input JSONB NOT NULL,
  
  -- Requirements
  requirements_json JSONB NOT NULL,
  
  -- Policy
  policy_json JSONB,
  
  -- Execution preferences
  execution_json JSONB,
  
  priority TEXT NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'critical')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'planning', 'scheduled', 'running', 'completed', 'failed', 'blocked'
  )),
  
  -- Timing
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  scheduled_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,
  
  -- Scheduling decisions
  scheduler_reasons TEXT[]
);

CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_priority ON tasks(priority);
CREATE INDEX idx_tasks_created_at ON tasks(created_at);

-- ==================== EXECUTIONS ====================

CREATE TABLE executions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  computer_id TEXT NOT NULL REFERENCES computers(id),
  runtime_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued', 'assigned', 'running', 'waiting', 'completed', 'failed', 'cancelled'
  )),
  
  -- Timing
  started_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  
  -- Metrics (stored as JSON for flexibility)
  metrics_json JSONB
);

CREATE INDEX idx_executions_task_id ON executions(task_id);
CREATE INDEX idx_executions_status ON executions(status);
CREATE INDEX idx_executions_computer_id ON executions(computer_id);

-- ==================== EXECUTION EVENTS ====================

CREATE TABLE execution_events (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'execution.created', 'execution.scheduled', 'execution.assigned',
    'model.loading', 'model.loaded',
    'generation.started', 'generation.token',
    'tool.requested', 'tool.completed',
    'generation.completed', 'execution.completed'
  )),
  payload JSONB,
  timestamp TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_execution_events_execution_id ON execution_events(execution_id);
CREATE INDEX idx_execution_events_type ON execution_events(event_type);
CREATE INDEX idx_execution_events_timestamp ON execution_events(timestamp);

-- ==================== POLICIES ====================

CREATE TABLE policies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  config_json JSONB NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- ==================== TOOLS ====================

CREATE TABLE tools (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  input_schema JSONB NOT NULL,
  permissions_json JSONB NOT NULL,
  category TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- ==================== BENCHMARKS ====================

CREATE TABLE benchmarks (
  id SERIAL PRIMARY KEY,
  model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  runtime_id TEXT NOT NULL,
  computer_id TEXT NOT NULL,
  
  -- Metrics
  ttft_ms DECIMAL(10, 2),
  tokens_per_sec DECIMAL(10, 2),
  context_capacity INTEGER,
  memory_usage_gb INTEGER,
  cpu_utilization_percent DECIMAL(5, 2),
  gpu_utilization_percent DECIMAL(5, 2),
  quality_score DECIMAL(3, 2),
  
  tested_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  test_type TEXT
);

CREATE INDEX idx_benchmarks_model_id ON benchmarks(model_id);
CREATE INDEX idx_benchmarks_computer_id ON benchmarks(computer_id);

-- ==================== PROMPTS ====================

CREATE TABLE prompts (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  
  UNIQUE(id, version)
);

-- ==================== EVALUATIONS ====================

CREATE TABLE evaluations (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  models_evaluated JSONB NOT NULL,
  comparison_json JSONB,
  winner_model_id TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- ==================== VIEWS ====================

CREATE VIEW v_computer_status AS
SELECT 
  c.id,
  c.name,
  c.status,
  c.type,
  c.cpu,
  c.memory_gb,
  c.gpu_model,
  c.gpu_memory_gb,
  rs.cpu_percent,
  rs.memory_used_gb,
  rs.memory_available_gb,
  rs.gpu_utilization_percent,
  rs.gpu_memory_used_gb,
  rs.gpu_memory_available_gb,
  rs.captured_at
FROM computers c
LEFT JOIN LATERAL (
  SELECT * 
  FROM computer_resource_state 
  WHERE computer_id = c.id 
  ORDER BY captured_at DESC 
  LIMIT 1
) rs ON TRUE;

CREATE VIEW v_task_status AS
SELECT 
  t.*,
  COUNT(e.id) FILTER (WHERE e.status = 'completed') as completed_executions,
  COUNT(e.id) FILTER (WHERE e.status IN ('running', 'queued')) as active_executions
FROM tasks t
LEFT JOIN executions e ON t.id = e.task_id
GROUP BY t.id;

CREATE VIEW v_model_status AS
SELECT 
  m.*,
  COUNT(DISTINCT r.computer_id) as available_on_computers
FROM models m
JOIN runtimes r ON m.runtime_id = r.id
GROUP BY m.id;

-- ==================== TRIGGERS ====================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_computers_updated_at
  BEFORE UPDATE ON computers
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_models_updated_at
  BEFORE UPDATE ON models
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- ==================== SAMPLE DATA ====================

INSERT INTO runtimes (id, name, version, status) VALUES 
  ('ollama', 'Ollama', '0.31.0', 'healthy'),
  ('lmstudio', 'LM Studio', '0.5.0', 'healthy');
