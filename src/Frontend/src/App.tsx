import { useState } from 'react'
import { useConfig } from './hooks/useConfig'
import { useToast, ToastContainer } from './components/Toast'
import { Navbar } from './components/Navbar'
import { PlaceOrderTab } from './tabs/PlaceOrderTab'
import { RaceConditionTab } from './tabs/RaceConditionTab'
import { OrderHistoryTab } from './tabs/OrderHistoryTab'
import { InventoryTab } from './tabs/InventoryTab'
import { ComparisonTab } from './tabs/ComparisonTab'

const tabs = ['Place Order', 'Race Condition', 'Order History', 'Inventory', 'Thesis Comparison'] as const

export default function App() {
  const { config, healthy } = useConfig()
  const { messages, addToast } = useToast()
  const [activeTab, setActiveTab] = useState(0)

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar config={config} healthy={healthy} />
      <ToastContainer messages={messages} />

      <div className="border-b bg-white">
        <div className="max-w-6xl mx-auto flex">
          {tabs.map((tab, i) => (
            <button
              key={tab}
              onClick={() => setActiveTab(i)}
              className={`px-5 py-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === i
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {tab}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 max-w-6xl mx-auto w-full p-6">
        {activeTab === 0 && <PlaceOrderTab onError={addToast} />}
        {activeTab === 1 && <RaceConditionTab onError={addToast} />}
        {activeTab === 2 && <OrderHistoryTab onError={addToast} />}
        {activeTab === 3 && <InventoryTab onError={addToast} />}
        {activeTab === 4 && <ComparisonTab onError={addToast} sagaMode={config?.sagaMode ?? 'unknown'} />}
      </div>
    </div>
  )
}
