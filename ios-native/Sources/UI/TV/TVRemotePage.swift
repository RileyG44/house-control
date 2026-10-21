import SwiftUI

struct TVRemotePage: View {
    let id: String
    @Environment(HomeStore.self) private var store
    var body: some View {
        let d = store.tv.device(id)
        Text(d?.status(available: store.tv.state.available) ?? "Connecting…")
            .navigationTitle(d?.name ?? "TV")
            .navigationBarTitleDisplayMode(.inline)
    }
}
