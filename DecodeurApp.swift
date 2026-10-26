import SwiftUI
import WebKit
import Vision
import UIKit

// Décodeur — application autonome.
// L'interface et tout le moteur d'analyse sont dans le dossier « web » embarqué dans l'appli
// (lecture des bougies, indicateurs, niveaux, figures, scénarios, traduction en clair).
// Cette partie Swift ne fait que trois choses : afficher l'interface, lire le texte de la capture
// avec la reconnaissance de texte intégrée à iOS, et enregistrer réglages et historique sur le téléphone.
// Aucune connexion internet n'est utilisée.

@main
struct DecodeurApp: App {
    var body: some Scene {
        WindowGroup {
            WebContainer()
                .ignoresSafeArea()
                .background(Color(uiColor: .decodeurBackground).ignoresSafeArea())
        }
    }
}

extension UIColor {
    static let decodeurBackground = UIColor(dynamicProvider: { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 15 / 255, green: 20 / 255, blue: 25 / 255, alpha: 1)
            : UIColor(red: 237 / 255, green: 240 / 255, blue: 242 / 255, alpha: 1)
    })
}

struct WebContainer: UIViewRepresentable {
    func makeCoordinator() -> NativeBridge {
        NativeBridge()
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        let controller = configuration.userContentController
        controller.addScriptMessageHandler(context.coordinator, contentWorld: .page, name: "ocr")
        controller.addScriptMessageHandler(context.coordinator, contentWorld: .page, name: "store")

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.isOpaque = false
        webView.backgroundColor = .decodeurBackground
        webView.scrollView.backgroundColor = .decodeurBackground
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.allowsBackForwardNavigationGestures = false

        if let index = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "web") {
            webView.loadFileURL(index, allowingReadAccessTo: index.deletingLastPathComponent())
        } else {
            webView.loadHTMLString(
                "<p style='font:17px -apple-system;padding:40px'>Les fichiers de l'interface sont introuvables dans l'appli.</p>",
                baseURL: nil
            )
        }
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

/// Reçoit les demandes de l'interface et y répond.
final class NativeBridge: NSObject, WKScriptMessageHandlerWithReply {
    private let store = FileStore()

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let body = message.body as? [String: Any] else {
            replyHandler(nil, "Message illisible")
            return
        }
        switch message.name {
        case "ocr":
            guard let dataURL = body["image"] as? String else {
                replyHandler(nil, "Image manquante")
                return
            }
            DispatchQueue.global(qos: .userInitiated).async {
                let result = TextReader.recognize(dataURL: dataURL)
                DispatchQueue.main.async {
                    switch result {
                    case .success(let items):
                        replyHandler(items, nil)
                    case .failure(let error):
                        replyHandler(nil, error.localizedDescription)
                    }
                }
            }
        case "store":
            let operation = body["op"] as? String ?? ""
            let key = body["key"] as? String ?? ""
            switch operation {
            case "get":
                replyHandler(store.read(key), nil)
            case "set":
                store.write(key, value: body["value"] as? String ?? "")
                replyHandler(true, nil)
            default:
                replyHandler(nil, "Opération inconnue")
            }
        default:
            replyHandler(nil, "Canal inconnu")
        }
    }
}

/// Lecture du texte de la capture (prix de l'axe, paire, unité de temps) par la reconnaissance de texte d'iOS.
enum TextReader {
    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    static func recognize(dataURL: String) -> Result<[[String: Any]], Error> {
        guard let comma = dataURL.firstIndex(of: ","),
              let data = Data(base64Encoded: String(dataURL[dataURL.index(after: comma)...])),
              let image = UIImage(data: data),
              let cgImage = image.cgImage else {
            return .failure(Failure(message: "Image illisible"))
        }

        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        request.recognitionLanguages = ["en-US", "fr-FR"]
        // Par défaut iOS ignore les textes plus petits qu'1/32 de la hauteur : les prix de l'axe sont bien plus petits.
        request.minimumTextHeight = 0.004

        let handler = VNImageRequestHandler(cgImage: cgImage, orientation: .up, options: [:])
        do {
            try handler.perform([request])
        } catch {
            return .failure(error)
        }

        let observations = request.results ?? []
        let items: [[String: Any]] = observations.compactMap { observation in
            guard let candidate = observation.topCandidates(1).first else { return nil }
            let box = observation.boundingBox
            return [
                "text": candidate.string,
                "x": Double(box.minX),
                "y": Double(1 - box.maxY),
                "w": Double(box.width),
                "h": Double(box.height),
                "confidence": Double(candidate.confidence)
            ]
        }
        return .success(items)
    }
}

/// Réglages et historique, enregistrés dans les fichiers privés de l'appli.
final class FileStore {
    private let folder: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let url = base.appendingPathComponent("Decodeur", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }()

    private func fileURL(for key: String) -> URL {
        let safe = key.replacingOccurrences(of: "[^A-Za-z0-9._-]", with: "_", options: .regularExpression)
        return folder.appendingPathComponent(safe + ".json")
    }

    func read(_ key: String) -> String? {
        try? String(contentsOf: fileURL(for: key), encoding: .utf8)
    }

    func write(_ key: String, value: String) {
        try? value.write(to: fileURL(for: key), atomically: true, encoding: .utf8)
    }
}
