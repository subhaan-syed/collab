import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { HomePage } from './components/HomePage/HomePage';
import { EditorPage } from './components/Editor/EditorPage';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/doc/:docId" element={<EditorPage />} />
      </Routes>
    </BrowserRouter>
  );
}
