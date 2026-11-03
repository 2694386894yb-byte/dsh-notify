import Foundation
import CoreImage
import AppKit

let args = CommandLine.arguments
guard args.count >= 3 else {
    FileHandle.standardError.write(Data("usage: qr <text> <out.png>\n".utf8)); exit(2)
}
let text = args[1]
let out = args[2]
guard let data = text.data(using: .utf8),
      let filter = CIFilter(name: "CIQRCodeGenerator") else { exit(1) }
filter.setValue(data, forKey: "inputMessage")
filter.setValue("M", forKey: "inputCorrectionLevel")
guard let output = filter.outputImage else { exit(1) }
let scaled = output.transformed(by: CGAffineTransform(scaleX: 12, y: 12))
let rep = NSBitmapImageRep(ciImage: scaled)
guard let png = rep.representation(using: .png, properties: [:]) else { exit(1) }
try! png.write(to: URL(fileURLWithPath: out))
print(out)
