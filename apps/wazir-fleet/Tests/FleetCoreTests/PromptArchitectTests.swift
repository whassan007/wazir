import Foundation
import Testing
@testable import FleetCore

@Suite("Prompt Architect & Composer")
struct PromptArchitectTests {
    let engine = PromptArchitectEngine()

    @Test func buildMessagesIncludesProjectRepoContext() {
        let ctx = ProjectRepositoryContext(
            repoPath: "/Users/wael/Code/Fleet",
            gitBranch: "release/fleet-core-1.0.0-rc1",
            trackedFiles: ["Package.swift", "Sources/FleetCore/Config.swift"],
            dirtyHumanFiles: ["HANDOFF.md"],
            detectedBuildSystem: .swiftPackage
        )
        let msgs = engine.buildMessages(roughIdea: "Add caching layer", style: .featureImplementation, repoContext: ctx)
        #expect(msgs.count == 2)
        #expect(msgs[0].content.contains("Feature Implementation"))
        #expect(msgs[1].content.contains("/Users/wael/Code/Fleet"))
        #expect(msgs[1].content.contains("swiftPackage"))
        #expect(msgs[1].content.contains("HANDOFF.md"))
    }

    @Test func fallbackPromptSynthesizesStructuredGoal() {
        let out = engine.synthesizeStructuredFallbackPrompt(
            roughIdea: "Optimize scheduler",
            style: .optimizationLoop,
            repoContext: ProjectRepositoryContext(repoPath: "/Users/wael/Code/Fleet", gitBranch: "main")
        )
        #expect(out.contains("Optimize scheduler"))
        #expect(out.contains("Fleet"))
        #expect(out.contains("Optimization & Improvement Loop"))
    }
}
