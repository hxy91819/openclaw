import Foundation

enum ModelCatalogLoader {
    static var defaultPath: String {
        self.resolveDefaultPath()
    }

    private static let logger = Logger(subsystem: "ai.openclaw", category: "models")
    private nonisolated static let appSupportDir: URL = {
        let base = FileManager().urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return base.appendingPathComponent("OpenClaw", isDirectory: true)
    }()

    private static var cachePath: URL {
        self.appSupportDir.appendingPathComponent("model-catalog/models.generated.js", isDirectory: false)
    }

    static func load(from path: String) async throws -> [ModelChoice] {
        let expanded = (path as NSString).expandingTildeInPath
        guard let resolved = self.resolvePath(preferred: expanded) else {
            self.logger.error("model catalog load failed: file not found")
            throw NSError(
                domain: "ModelCatalogLoader",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Model catalog file not found"])
        }
        self.logger.debug("model catalog load start file=\(URL(fileURLWithPath: resolved.path).lastPathComponent)")
        let source = try String(contentsOfFile: resolved.path, encoding: .utf8)
        let rawModels = try self.parseModels(source: source)

        var choices: [ModelChoice] = []
        for (provider, value) in rawModels {
            guard let models = value as? [String: Any] else { continue }
            for (id, payload) in models {
                guard let dict = payload as? [String: Any] else { continue }
                let name = dict["name"] as? String ?? id
                let ctxWindow = dict["contextWindow"] as? Int
                choices.append(ModelChoice(id: id, name: name, provider: provider, contextWindow: ctxWindow))
            }
        }

        let sorted = choices.sorted { lhs, rhs in
            if lhs.provider == rhs.provider {
                return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
            }
            return lhs.provider.localizedCaseInsensitiveCompare(rhs.provider) == .orderedAscending
        }
        self.logger.debug("model catalog loaded providers=\(rawModels.count) models=\(sorted.count)")
        if resolved.shouldCache {
            self.cacheCatalog(sourcePath: resolved.path)
        }
        return sorted
    }

    private static func resolveDefaultPath() -> String {
        let cache = self.cachePath.path
        if FileManager().isReadableFile(atPath: cache) { return cache }
        if let bundlePath = self.bundleCatalogPath() { return bundlePath }
        if let nodePath = self.nodeModulesCatalogPath() { return nodePath }
        return cache
    }

    private static func resolvePath(preferred: String) -> (path: String, shouldCache: Bool)? {
        if FileManager().isReadableFile(atPath: preferred) {
            return (preferred, preferred != self.cachePath.path)
        }

        if let bundlePath = self.bundleCatalogPath(), bundlePath != preferred {
            self.logger.warning("model catalog path missing; falling back to bundled catalog")
            return (bundlePath, true)
        }

        let cache = self.cachePath.path
        if cache != preferred, FileManager().isReadableFile(atPath: cache) {
            self.logger.warning("model catalog path missing; falling back to cached catalog")
            return (cache, false)
        }

        if let nodePath = self.nodeModulesCatalogPath(), nodePath != preferred {
            self.logger.warning("model catalog path missing; falling back to node_modules catalog")
            return (nodePath, true)
        }

        return nil
    }

    private static func bundleCatalogPath() -> String? {
        guard let url = Bundle.main.url(forResource: "models.generated", withExtension: "js") else {
            return nil
        }
        return url.path
    }

    private static func nodeModulesCatalogPath() -> String? {
        let roots = [
            URL(fileURLWithPath: CommandResolver.projectRootPath()),
            URL(fileURLWithPath: FileManager().currentDirectoryPath),
        ]
        for root in roots {
            let candidate = root
                .appendingPathComponent("node_modules/@mariozechner/pi-ai/dist/models.generated.js")
            if FileManager().isReadableFile(atPath: candidate.path) {
                return candidate.path
            }
        }
        return nil
    }

    private static func cacheCatalog(sourcePath: String) {
        let destination = self.cachePath
        do {
            try FileManager().createDirectory(
                at: destination.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            if FileManager().fileExists(atPath: destination.path) {
                try FileManager().removeItem(at: destination)
            }
            try FileManager().copyItem(atPath: sourcePath, toPath: destination.path)
            self.logger.debug("model catalog cached file=\(destination.lastPathComponent)")
        } catch {
            self.logger.warning("model catalog cache failed: \(error.localizedDescription)")
        }
    }

    private static func parseModels(source: String) throws -> [String: Any] {
        guard let objectLiteral = self.extractModelsObjectLiteral(from: source) else {
            return [:]
        }
        // Keep the loader data-only: normalize the known object-literal subset and let JSON parsing
        // reject anything expression-like instead of executing user-controlled JavaScript.
        let normalized = self.normalizeObjectLiteralForJSON(objectLiteral)
        guard let data = normalized.data(using: .utf8) else {
            self.logger.error("model catalog parse failed: unsupported syntax")
            throw self.invalidCatalogError()
        }
        let object: Any
        do {
            object = try JSONSerialization.jsonObject(with: data)
        } catch {
            self.logger.error("model catalog parse failed: unsupported syntax")
            throw self.invalidCatalogError()
        }
        guard let root = object as? [String: Any] else {
            self.logger.error("model catalog parse failed: MODELS root is not an object")
            throw self.invalidCatalogError()
        }
        return root
    }

    private static func extractModelsObjectLiteral(from source: String) -> String? {
        guard let exportRange = source.range(of: "export const MODELS"),
              let firstBrace = source[exportRange.upperBound...].firstIndex(of: "{"),
              let lastBrace = self.findMatchingClosingBrace(in: source, openingBrace: firstBrace)
        else {
            return nil
        }
        return String(source[firstBrace...lastBrace])
    }

    private static func findMatchingClosingBrace(
        in source: String,
        openingBrace: String.Index
    ) -> String.Index? {
        var depth = 0
        var activeQuote: Character?
        var isEscaping = false
        var index = openingBrace
        while index < source.endIndex {
            let ch = source[index]
            if let quote = activeQuote {
                if isEscaping {
                    isEscaping = false
                } else if ch == "\\" {
                    isEscaping = true
                } else if ch == quote {
                    activeQuote = nil
                }
            } else {
                if ch == "\"" || ch == "'" {
                    activeQuote = ch
                } else if ch == "{" {
                    depth += 1
                } else if ch == "}" {
                    depth -= 1
                    if depth == 0 {
                        return index
                    }
                }
            }
            index = source.index(after: index)
        }
        return nil
    }

    private static func normalizeObjectLiteralForJSON(_ objectLiteral: String) -> String {
        var body = objectLiteral.replacingOccurrences(
            of: #"(?m)\bsatisfies\s+[^,}\n]+"#,
            with: "",
            options: .regularExpression)
        body = body.replacingOccurrences(
            of: #"(?m)\bas\s+[^;,\n]+"#,
            with: "",
            options: .regularExpression)
        body = body.replacingOccurrences(
            of: #"(?<=\d)_(?=\d)"#,
            with: "",
            options: .regularExpression)
        body = body.replacingOccurrences(
            of: #"([,{]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:"#,
            with: "$1\"$2\":",
            options: .regularExpression)
        body = body.replacingOccurrences(
            of: #",(\s*[}\]])"#,
            with: "$1",
            options: .regularExpression)
        return body
    }

    private static func invalidCatalogError() -> NSError {
        NSError(
            domain: "ModelCatalogLoader",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "Failed to parse models.generated.ts"])
    }
}
