#!/usr/bin/env python3
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKILL = Path(os.environ.get(
    "PROJECT_AGENT_TEAM_BUILDER_SKILL",
    Path.home() / ".hermes/skills/autonomous-ai-agents/project-agent-team-builder",
))
MANIFEST = ROOT / "agent-system/team.json"
ROUTING = ROOT / "agent-system/evals/routing-cases.json"
BEHAVIORAL = ROOT / "agent-system/evals/behavioral-cases.json"
REQUIRED_HEADINGS = [
    "## Personality and judgment principles",
    "## Over-action prevention",
    "## Uncertainty and blocker handling",
    "## Handoff contract",
    "## Completion verdict",
]
EXPECTED_PROFILES = {
    "moe-spec",
    "moe-simulator-builder",
    "moe-model-validator",
    "moe-browser-repro-reviewer",
    "moe-release-gate",
}
ROLE_CLASS_PROFILES = {
    "scientific-spec": "moe-spec",
    "change-owner": "moe-simulator-builder",
    "independent-model-validator": "moe-model-validator",
    "independent-browser-reviewer": "moe-browser-repro-reviewer",
    "release-gate": "moe-release-gate",
}


def run_tool(*args: str | Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, *map(str, args)],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )


class ProjectAgentSystemContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))

    def test_manifest_passes_bundled_validator(self) -> None:
        result = run_tool(SKILL / "scripts/validate_manifest.py", MANIFEST)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_minimum_scientific_team_and_independent_release_graph(self) -> None:
        profiles = {profile["name"] for profile in self.manifest["profiles"]}
        self.assertEqual(profiles, EXPECTED_PROFILES)
        model_nodes = {node["id"]: node for node in self.manifest["workflows"]["model-change"]["nodes"]}
        self.assertEqual(model_nodes["model-validate"]["parents"], ["model-implement"])
        self.assertEqual(model_nodes["browser-verify"]["parents"], ["model-implement"])
        self.assertEqual(
            set(model_nodes["model-release-gate"]["parents"]),
            {"model-validate", "browser-verify"},
        )
        self.assertNotEqual(
            self.manifest["stages"]["implement"]["assignee"],
            self.manifest["stages"]["model-validate"]["assignee"],
        )

    def test_every_routing_fixture_resolves_to_exact_manifest_graph(self) -> None:
        routing = json.loads(ROUTING.read_text(encoding="utf-8"))
        role_profiles = ROLE_CLASS_PROFILES
        self.assertEqual(set(role_profiles.values()), EXPECTED_PROFILES)
        for case in routing["cases"]:
            workflow_name = case.get("expectedWorkflow")
            if workflow_name is None:
                self.assertIn(case.get("expectedPrimitive"), {"current-session-or-one-profile"})
                continue
            workflow = self.manifest["workflows"][workflow_name]
            nodes = {node["id"]: node for node in workflow["nodes"]}
            profile_order = [
                self.manifest["stages"][node["stage"]]["assignee"]
                for node in workflow["nodes"]
            ]
            expected_profiles = [role_profiles[role] for role in case["expectedRoleClasses"]]
            self.assertEqual(profile_order, expected_profiles, case["id"])
            self.assertTrue(set(case.get("forbiddenProfiles", [])).isdisjoint(profile_order), case["id"])
            actual_edges = {
                (
                    self.manifest["stages"][nodes[parent]["stage"]]["assignee"],
                    self.manifest["stages"][node["stage"]]["assignee"],
                )
                for node in workflow["nodes"]
                for parent in node["parents"]
            }
            expected_edges = {
                (role_profiles[parent_role], role_profiles[child_role])
                for parent_role, child_role in case.get("expectedDependencyClasses", [])
            }
            self.assertEqual(actual_edges, expected_edges, case["id"])

    def test_role_souls_have_exact_behavioral_contract(self) -> None:
        for profile in self.manifest["profiles"]:
            soul = (ROOT / profile["soulFile"]).read_text(encoding="utf-8")
            positions = [soul.index(heading) for heading in REQUIRED_HEADINGS]
            self.assertEqual(positions, sorted(positions), profile["name"])
            self.assertIn("End with exactly one verdict: PASS, FAIL, BLOCKED, or PARTIAL.", soul)
            self.assertIn("Respond to the user in Korean", soul)

    def test_workflow_packets_fail_closed_on_full_handoff_metadata(self) -> None:
        result = run_tool(
            SKILL / "scripts/teamctl.py",
            MANIFEST,
            "workflow",
            "model-change",
            "--title",
            "contract-probe",
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        tasks = json.loads(result.stdout)["tasks"]
        required = {
            "verdict",
            "facts",
            "assumptions",
            "decision",
            "evidence",
            "counterevidence",
            "limitations",
            "remainingRisks",
            "humanActionRequired",
            "changedFiles",
            "receiver",
        }
        task_by_node = {task["nodeId"]: task for task in tasks}
        workflow_nodes = self.manifest["workflows"]["model-change"]["nodes"]
        for task in tasks:
            body = json.loads(task["body"])
            self.assertEqual(set(body["completionMetadataRequired"]), required)
            self.assertEqual(body["completionMetadataRequired"]["humanActionRequired"], "empty list[str] for PASS; block instead when human action is pending")
            self.assertEqual(body["logicalParentNodeIds"], task["parentNodeIds"])
            node = next(node for node in workflow_nodes if node["id"] == task["nodeId"])
            successors = [candidate for candidate in workflow_nodes if node["id"] in candidate["parents"]]
            if successors:
                assignees = sorted({self.manifest["stages"][candidate["stage"]]["assignee"] for candidate in successors})
                expected_receiver = assignees[0] if len(assignees) == 1 else assignees
            else:
                expected_receiver = self.manifest["stages"][node["stage"]]["remediationOwner"]
            self.assertEqual(body["expectedReceiver"], expected_receiver)
            self.assertEqual(task_by_node[task["nodeId"]]["assignee"], self.manifest["stages"][node["stage"]]["assignee"])
            if task["parentNodeIds"]:
                self.assertEqual(task["initialStatus"], "blocked")
                self.assertTrue(body["controllerAssignmentGate"])
                self.assertIn("created unassigned", body["completionProtocol"])

    def test_evals_pass_bundled_validators(self) -> None:
        routing = run_tool(SKILL / "scripts/validate_evals.py", "routing", ROUTING)
        behavioral = run_tool(SKILL / "scripts/validate_evals.py", "behavioral", BEHAVIORAL)
        self.assertEqual(routing.returncode, 0, routing.stdout + routing.stderr)
        self.assertEqual(behavioral.returncode, 0, behavioral.stdout + behavioral.stderr)

    def test_security_and_scientific_human_gates_are_explicit(self) -> None:
        security = self.manifest["security"]
        self.assertTrue(security["denyAllMessaging"])
        gates = " ".join(security["humanGates"]).lower()
        self.assertIn("external calibration", gates)
        self.assertIn("production release", gates)
        for profile in self.manifest["profiles"]:
            self.assertTrue(profile["messagingDisabled"])
            self.assertEqual(profile["source"], "create")
            self.assertEqual(profile["updatePolicy"], "reconcile")


if __name__ == "__main__":
    unittest.main(verbosity=2)
