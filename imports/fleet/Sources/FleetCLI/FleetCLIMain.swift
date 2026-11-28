import FleetCore
import Foundation

@main
struct FleetCLIMain {
    static func main() async {
        let args = Array(CommandLine.arguments.dropFirst())
        let jsonMode = args.contains("--json")
        let filtered = args.filter { $0 != "--json" }
        let input = filtered.joined(separator: " ")

        let runtime = ControlPlaneRuntime()
        if input.isEmpty {
            print("Fleet Core CLI (fleet) — Commands: " + FleetSlashCommand.allCases.map { "/\($0.rawValue)" }.joined(separator: ", "))
            return
        }

        let response = await runtime.handleSlashCommand(input)
        if jsonMode {
            let enc = JSONEncoder()
            enc.outputFormatting = [.prettyPrinted, .sortedKeys]
            if let data = try? enc.encode(response), let str = String(data: data, encoding: .utf8) {
                print(str)
            }
        } else {
            print("[\(response.status.uppercased())] \(response.command): \(response.summary)")
        }
    }
}
