import AppKit
import Foundation

struct Snapshot: Decodable {
  let state: PetState
  let pet: Pet?
  let options: FloatingOptions?
}

struct FloatingOptions: Decodable {
  let backgroundOpacity: Double?
  let messageOpacity: Double?
}

struct PetState: Decodable {
  let enabled: Bool
  let mood: String
  let message: String
  let selectedPetId: String
  let animationLevel: String
}

struct Pet: Decodable {
  let id: String
  let name: String
  let author: String
  let description: String
  let sourceUrl: String
  let asset: PetAsset
}

struct PetAsset: Decodable {
  let type: String
  let entry: String
  let frames: Int?
  let row: Int?
  let scale: Double?
  let frameWidth: Int?
  let frameHeight: Int?
  let sheetWidth: Int?
  let sheetHeight: Int?
}

final class PetView: NSView {
  private var cachedImageUrl: String?
  private var cachedImage: NSImage?
  /// Path to a small signal file the VS Code extension watches; a click on the chat strip overwrites it.
  var signalFilePath: String = "" {
    didSet {
      let ok = signalFilePath.isEmpty == false
      chatButton.isHidden = !ok
      chatButton.isEnabled = ok
    }
  }

  private let chatButton: NSButton = {
    let b = NSButton()
    b.title = "Ouvrir le chat Cursor"
    b.bezelStyle = .rounded
    b.isBordered = false
    b.wantsLayer = true
    b.layer?.cornerRadius = 10
    b.layer?.backgroundColor = NSColor(calibratedWhite: 0.14, alpha: 0.92).cgColor
    b.font = NSFont.systemFont(ofSize: 12, weight: .semibold)
    b.contentTintColor = NSColor(calibratedWhite: 1, alpha: 0.92)
    b.setButtonType(.momentaryPushIn)
    b.focusRingType = .none
    b.toolTip = "Envoie une demande à CursorPets dans l’éditeur pour ouvrir le chat (Cursor doit être ouvert)."
    return b
  }()

  private let chatStripHeight: CGFloat = 36
  private let edgePad: CGFloat = 10
  private let layoutGap: CGFloat = 8
  private let messageBubbleHeight: CGFloat = 70

  var snapshot: Snapshot? {
    didSet {
      needsDisplay = true
    }
  }

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
    chatButton.target = self
    chatButton.action = #selector(chatButtonPushed(_:))
    chatButton.isHidden = true
    chatButton.isEnabled = false
    addSubview(chatButton)
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
    true
  }

  override func layout() {
    super.layout()
    chatButton.frame = stripFrame(in: bounds)
  }

  @objc private func chatButtonPushed(_ sender: Any?) {
    guard signalFilePath.isEmpty == false else {
      return
    }
    let stamp = "\(Date().timeIntervalSince1970)-\(UUID().uuidString.prefix(8))\n"
    if let data = stamp.data(using: .utf8) {
      FileManager.default.createFile(atPath: signalFilePath, contents: data, attributes: nil)
    }
    if #available(macOS 10.11, *) {
      NSHapticFeedbackManager.defaultPerformer.perform(.generic, performanceTime: .default)
    }
  }

  private func stripFrame(in rect: NSRect) -> CGRect {
    CGRect(x: edgePad, y: edgePad, width: rect.width - edgePad * 2, height: chatStripHeight)
  }

  private func messageFrame(in rect: NSRect) -> CGRect {
    let y = edgePad + chatStripHeight + layoutGap
    return CGRect(x: 18, y: y, width: rect.width - 36, height: messageBubbleHeight)
  }

  private func petFrame(in rect: NSRect) -> CGRect {
    let m = messageFrame(in: rect)
    let bottom = m.maxY + layoutGap
    return CGRect(x: rect.minX + 18, y: bottom, width: rect.width - 36, height: rect.maxY - bottom - 14)
  }

  override func draw(_ dirtyRect: NSRect) {
    super.draw(dirtyRect)

    guard let context = NSGraphicsContext.current?.cgContext else {
      return
    }

    let snapshot = snapshot
    let mood = snapshot?.state.mood ?? "idle"
    let enabled = snapshot?.state.enabled ?? true
    let entry = snapshot?.pet?.asset.entry ?? "nukey-preview"
    let message = enabled ? snapshot?.state.message ?? "Ready when you are." : "Paused"

    context.clear(bounds)
    drawBackground(in: context, rect: bounds, opacity: CGFloat(snapshot?.options?.backgroundOpacity ?? 0.32))
    let petArea = petFrame(in: bounds)
    if snapshot?.pet?.asset.type == "spritesheet", let image = loadImage(entry) {
      drawSpritesheetPet(image, in: context, rect: petArea.insetBy(dx: 4, dy: 4), mood: mood, enabled: enabled, asset: snapshot?.pet?.asset)
    } else {
      drawPet(in: context, rect: petArea.insetBy(dx: 8, dy: 8), entry: entry, mood: mood, enabled: enabled)
    }
    drawMessage(message, in: messageFrame(in: bounds), opacity: CGFloat(snapshot?.options?.messageOpacity ?? 0.42))
  }

  override func mouseDown(with event: NSEvent) {
    window?.performDrag(with: event)
  }

  private func drawBackground(in context: CGContext, rect: NSRect, opacity: CGFloat) {
    let path = CGPath(roundedRect: rect.insetBy(dx: 6, dy: 6), cornerWidth: 22, cornerHeight: 22, transform: nil)
    context.setFillColor(NSColor(calibratedWhite: 0.08, alpha: opacity).cgColor)
    context.addPath(path)
    context.fillPath()
  }

  private func drawPet(in context: CGContext, rect: NSRect, entry: String, mood: String, enabled: Bool) {
    let color: NSColor = entry == "cloudlet-preview"
      ? NSColor(calibratedRed: 0.55, green: 0.84, blue: 0.84, alpha: enabled ? 1 : 0.45)
      : NSColor(calibratedRed: 0.96, green: 0.78, blue: 0.30, alpha: enabled ? 1 : 0.45)

    let wobble = CGFloat(sin(Date().timeIntervalSince1970 * 4.0))
    let hop = mood == "happy" ? max(0, wobble) * 8 : 0
    let shake = mood == "concerned" ? wobble * 4 : 0
    let petRect = rect.offsetBy(dx: shake, dy: hop)
    let body = CGRect(x: petRect.midX - 62, y: petRect.midY - 58, width: 124, height: 132)

    context.setFillColor(NSColor(calibratedWhite: 0, alpha: 0.28).cgColor)
    context.fillEllipse(in: CGRect(x: body.midX - 45, y: body.minY - 12, width: 90, height: 20))

    context.setFillColor(color.cgColor)
    context.fillEllipse(in: CGRect(x: body.minX + 10, y: body.maxY - 16, width: 36, height: 36))
    context.fillEllipse(in: CGRect(x: body.maxX - 46, y: body.maxY - 16, width: 36, height: 36))

    let bodyPath = CGPath(roundedRect: body, cornerWidth: 48, cornerHeight: 48, transform: nil)
    context.addPath(bodyPath)
    context.fillPath()

    context.setFillColor(NSColor(calibratedWhite: 0.05, alpha: 1).cgColor)
    let eyeHeight: CGFloat = mood == "waiting" ? 4 : 14
    context.fillEllipse(in: CGRect(x: body.midX - 34, y: body.midY + 10, width: 14, height: eyeHeight))
    context.fillEllipse(in: CGRect(x: body.midX + 20, y: body.midY + 10, width: 14, height: eyeHeight))

    context.setStrokeColor(NSColor(calibratedWhite: 0.05, alpha: 1).cgColor)
    context.setLineWidth(5)
    context.setLineCap(.round)
    let mouth = CGMutablePath()
    if mood == "concerned" {
      mouth.move(to: CGPoint(x: body.midX - 16, y: body.midY - 20))
      mouth.addQuadCurve(to: CGPoint(x: body.midX + 16, y: body.midY - 20), control: CGPoint(x: body.midX, y: body.midY - 4))
    } else {
      mouth.move(to: CGPoint(x: body.midX - 16, y: body.midY - 10))
      mouth.addQuadCurve(to: CGPoint(x: body.midX + 16, y: body.midY - 10), control: CGPoint(x: body.midX, y: body.midY - 28))
    }
    context.addPath(mouth)
    context.strokePath()
  }

  private func drawSpritesheetPet(_ image: NSImage, in context: CGContext, rect: NSRect, mood: String, enabled: Bool, asset: PetAsset?) {
    guard let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
      return
    }

    let frames = max(asset?.frames ?? 6, 1)
    let frameIndex = Int(Date().timeIntervalSince1970 * 7.0) % frames
    let frameWidth = asset?.frameWidth ?? (cgImage.width / 8)
    let frameHeight = asset?.frameHeight ?? 208
    let row = asset?.row ?? 0
    let sourceRect = CGRect(x: frameIndex * frameWidth, y: row * frameHeight, width: frameWidth, height: frameHeight)
    let scale = CGFloat(asset?.scale ?? 1)
    let size = min(rect.width, rect.height) * scale
    let target = CGRect(x: rect.midX - size / 2, y: rect.midY - size / 2 + 8, width: size, height: size)

    guard let frame = cgImage.cropping(to: sourceRect) else {
      return
    }

    context.saveGState()
    context.setAlpha(enabled ? 1 : 0.48)
    context.draw(frame, in: target)
    context.restoreGState()
  }

  private func loadImage(_ urlString: String) -> NSImage? {
    if cachedImageUrl == urlString {
      return cachedImage
    }

    guard let url = URL(string: urlString), let data = try? Data(contentsOf: url), let image = NSImage(data: data) else {
      return nil
    }

    cachedImageUrl = urlString
    cachedImage = image
    return image
  }

  private func drawMessage(_ message: String, in messageRect: NSRect, opacity: CGFloat) {
    let bubblePath = CGPath(roundedRect: messageRect.insetBy(dx: -10, dy: -8), cornerWidth: 14, cornerHeight: 14, transform: nil)
    guard let context = NSGraphicsContext.current?.cgContext else {
      return
    }

    context.setFillColor(NSColor(calibratedWhite: 0.04, alpha: opacity).cgColor)
    context.addPath(bubblePath)
    context.fillPath()

    let paragraph = NSMutableParagraphStyle()
    paragraph.alignment = .center
    paragraph.lineBreakMode = .byWordWrapping
    paragraph.lineSpacing = 2

    let attributes: [NSAttributedString.Key: Any] = [
      .font: NSFont.systemFont(ofSize: message.count > 90 ? 11 : 12, weight: .semibold),
      .foregroundColor: NSColor(calibratedWhite: 1, alpha: 0.88),
      .paragraphStyle: paragraph
    ]
    let attributed = NSAttributedString(string: shortenedMessage(message), attributes: attributes)
    attributed.draw(
      with: messageRect,
      options: [.usesLineFragmentOrigin, .usesFontLeading, .truncatesLastVisibleLine],
      context: nil
    )
  }

  private func shortenedMessage(_ message: String) -> String {
    let collapsed = message
      .replacingOccurrences(of: "\n", with: " ")
      .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
      .trimmingCharacters(in: .whitespacesAndNewlines)

    if collapsed.count <= 180 {
      return collapsed
    }

    let endIndex = collapsed.index(collapsed.startIndex, offsetBy: 177)
    return "\(collapsed[..<endIndex])..."
  }
}

final class FloatingPetApp: NSObject, NSApplicationDelegate {
  private let statePath: String
  private let signalPath: String
  private let petView = PetView(frame: NSRect(x: 0, y: 0, width: 260, height: 340))
  private var window: NSPanel?
  private var timer: Timer?

  init(statePath: String, signalPath: String) {
    self.statePath = statePath
    self.signalPath = signalPath
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    petView.signalFilePath = signalPath
    let panel = NSPanel(
      contentRect: NSRect(x: 1200, y: 570, width: 260, height: 340),
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false
    )
    panel.level = .floating
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = true
    panel.isMovableByWindowBackground = true
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
    panel.contentView = petView
    panel.orderFrontRegardless()
    window = panel

    loadSnapshot()
    timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
      self?.loadSnapshot()
    }
  }

  private func loadSnapshot() {
    guard
      let data = FileManager.default.contents(atPath: statePath),
      let snapshot = try? JSONDecoder().decode(Snapshot.self, from: data)
    else {
      return
    }
    petView.snapshot = snapshot
  }
}

/// Spawned as `swift CursorPetsFloat.swift [<signal-path>] <state-json>` — **state JSON is always the last** argument.
private func parseFloatCli() -> (state: String, signal: String) {
  let args = CommandLine.arguments
  guard args.count >= 2 else {
    return ("", "")
  }
  let state = args[args.count - 1]
  if args.count >= 3 {
    let signal = args[args.count - 2]
    return (state, signal)
  }
  let dir = (state as NSString).deletingLastPathComponent
  let signal = (dir as NSString).appendingPathComponent("floating-pet-open-chat.signal")
  return (state, signal)
}

let (statePath, signalPath) = parseFloatCli()
let app = NSApplication.shared
let delegate = FloatingPetApp(statePath: statePath, signalPath: signalPath)
app.setActivationPolicy(.accessory)
app.delegate = delegate
app.run()
