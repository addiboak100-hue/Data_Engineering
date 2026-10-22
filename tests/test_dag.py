"""Structural checks on the Airflow DAG, without needing Airflow installed.

If Airflow *is* installed, the DAG is also loaded for real and its task graph
is checked.
"""

import ast
import importlib.util
import sys
import unittest
from pathlib import Path

DAG_FILE = Path(__file__).resolve().parent.parent / "dags" / "crypto_pipeline.py"
TASKS = {"fetch_prices", "validate_prices", "record_forecasts", "run_backtest", "score_forecasts"}
STEP_CALLS = {"fetch", "validate", "record_forecasts", "backtest", "score"}


class DagSource(unittest.TestCase):
    def setUp(self):
        self.tree = ast.parse(DAG_FILE.read_text(encoding="utf-8"))

    def test_has_every_task_and_calls_the_pipeline(self):
        funcs = {n.name for n in ast.walk(self.tree) if isinstance(n, ast.FunctionDef)}
        self.assertTrue(TASKS <= funcs, TASKS - funcs)
        called = {n.func.attr for n in ast.walk(self.tree)
                  if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
                  and isinstance(n.func.value, ast.Name) and n.func.value.id == "pipeline"}
        self.assertEqual(called, STEP_CALLS)

    def test_pipeline_steps_exist(self):
        from src import pipeline

        for name in STEP_CALLS:
            self.assertTrue(callable(getattr(pipeline, name)), name)

    def test_project_is_imported_inside_tasks_only(self):
        # Top-level `import src...` would make Airflow load Prophet on every DAG parse.
        top = [n for n in self.tree.body if isinstance(n, (ast.Import, ast.ImportFrom))]
        mods = {getattr(n, "module", None) or n.names[0].name for n in top}
        self.assertFalse(any(m and m.startswith("src") for m in mods), mods)


@unittest.skipUnless(importlib.util.find_spec("airflow"), "Airflow not installed")
class DagLoads(unittest.TestCase):
    def test_graph(self):
        spec = importlib.util.spec_from_file_location("crypto_pipeline", DAG_FILE)
        mod = importlib.util.module_from_spec(spec)
        sys.modules["crypto_pipeline"] = mod
        spec.loader.exec_module(mod)
        dag = next(v for v in vars(mod).values() if getattr(v, "dag_id", None) == "crypto_forecast_pipeline")
        self.assertEqual(set(dag.task_ids), TASKS)
        self.assertEqual(dag.get_task("validate_prices").upstream_task_ids, {"fetch_prices"})
        self.assertEqual(dag.get_task("score_forecasts").upstream_task_ids, {"record_forecasts", "run_backtest"})


if __name__ == "__main__":
    unittest.main()
